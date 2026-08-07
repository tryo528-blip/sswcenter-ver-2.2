"""W1F HIGH integration/recovery RED-first contract.

Sealed nodes bind the W1F backup/restore recovery boundary at the current
Alembic head ``20260806_0015_recipient_status_tag``. Probes for W1D/W1E/0013/
0014/0015 are dynamic; postcheck/wrapper/W1C checks are static source evidence.

Preserve W1D downgrade and existing 0011~0014 restore support/markers. Current-
head synthetic backup/restore must seed and full-row-hash 0013 continuing
education and 0014 plan notification, and include recipient 0015 status via
to_jsonb(recipient) full-row canonical evidence.
"""

from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import tempfile
import uuid
from pathlib import Path
from typing import NoReturn

import pytest

REPO_ROOT = Path(__file__).resolve().parents[2]
SCRIPTS_ROOT = REPO_ROOT / "scripts"
RESTORE_DRILL = SCRIPTS_ROOT / "restore-drill.ps1"
W1C_WRAPPER = SCRIPTS_ROOT / "test-w1c-postgres.ps1"
W1F_WRAPPER = SCRIPTS_ROOT / "test-w1f-postgres.ps1"
W1A_RRN_DETECTOR = SCRIPTS_ROOT / "w1a-rrn-detector.ps1"
POSTCHECK = REPO_ROOT / "backend" / "app" / "db" / "postcheck_w1a_vs1.py"
PLAN_NOTIFICATION_E2E = (
    REPO_ROOT / "frontend" / "e2e" / "recipient-plan-notification-real-pg.spec.ts"
)

W1B_REVISION = "20260730_0009_w1b_recipient"
W1C_REVISION = "20260730_0010_w1c_certification_ledgers"
W1D_REVISION = "20260730_0011_w1d_recipient_contract"
W1E_REVISION = "20260801_0012_w1e_care_assignment"
CONTINUING_EDUCATION_REVISION = "20260802_0013_staff_continuing_education"
RECIPIENT_PLAN_NOTIFICATION_REVISION = "20260803_0014_recipient_plan_notification"
RECIPIENT_STATUS_TAG_REVISION = "20260806_0015_recipient_status_tag"
CURRENT_HEAD = RECIPIENT_STATUS_TAG_REVISION

UNSUPPORTED_REVISION_MARKER = "Unsupported backup Alembic revision"
ARTIFACT_STAGE_MARKER = "Backup dump file is missing"

W1D_MARKER = "W1D_DB_POSTCHECK_OK"
W1E_MARKER = "W1E_DB_POSTCHECK_OK"
CONTINUING_EDUCATION_MARKER = "STAFF_CONTINUING_EDUCATION_DB_POSTCHECK_OK"
RECIPIENT_PLAN_NOTIFICATION_MARKER = "RECIPIENT_PLAN_NOTIFICATION_DB_POSTCHECK_OK"
RECIPIENT_STATUS_TAG_MARKER = "RECIPIENT_STATUS_TAG_DB_POSTCHECK_OK"

# Exact historical E2E fixture value, constructed only from fragments so this
# contract file itself never embeds a detector-visible contiguous RRN candidate.
PLAN_NOTIFICATION_SYNTHETIC_RRN = "90010" + "1-11234" + "99"


def _fail(marker: str) -> NoReturn:
    pytest.fail(marker, pytrace=False)


def _powershell_executable() -> str:
    system_root = os.environ.get("SystemRoot")
    if system_root:
        candidate = Path(system_root) / "System32" / "WindowsPowerShell" / "v1.0" / "powershell.exe"
        if candidate.is_file():
            return str(candidate)
    found = shutil.which("powershell") or shutil.which("powershell.exe")
    if found:
        return found
    _fail("W1F_HARNESS_POWERSHELL_MISSING: powershell.exe could not be resolved")


def _w1a_rrn_match_count(text: str) -> int:
    """Invoke the sealed W1A RRN detector against an in-memory text surface."""
    if not W1A_RRN_DETECTOR.is_file():
        _fail("W1F_HARNESS_RRN_DETECTOR_MISSING: scripts/w1a-rrn-detector.ps1 absent")
    powershell = _powershell_executable()
    probe = (
        "$ErrorActionPreference = 'Stop'; "
        f". '{W1A_RRN_DETECTOR.as_posix()}'; "
        "$text = [Console]::In.ReadToEnd(); "
        "Write-Output (Get-W1ARRNMatchCount -Text $text)"
    )
    try:
        completed = subprocess.run(
            [
                powershell,
                "-NoProfile",
                "-NonInteractive",
                "-ExecutionPolicy",
                "Bypass",
                "-Command",
                probe,
            ],
            input=text,
            cwd=str(REPO_ROOT),
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=60,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired):
        _fail("W1F_HARNESS_RRN_DETECTOR_UNRUNNABLE: W1A RRN detector could not run")
    if completed.returncode != 0:
        _fail(
            "W1F_HARNESS_RRN_DETECTOR_FAILED: "
            + (completed.stdout + "\n" + completed.stderr).strip()
        )
    lines = [line.strip() for line in completed.stdout.splitlines() if line.strip()]
    if not lines:
        _fail("W1F_HARNESS_RRN_DETECTOR_EMPTY: detector returned no match count")
    try:
        return int(lines[-1])
    except ValueError:
        _fail(f"W1F_HARNESS_RRN_DETECTOR_NON_INTEGER: {lines[-1]!r}")


def _run_restore_drill_manifest_probe(revision: str) -> tuple[int, str]:
    """Invoke restore-drill.ps1 against a synthetic manifest declaring ``revision``.

    The synthetic backup directory intentionally omits the dump file so that a
    restore that accepts the revision fails at artifact validation before any
    database or filesystem mutation. No real PostgreSQL cluster is touched.
    """

    if not RESTORE_DRILL.is_file():
        _fail("W1F_HARNESS_RESTORE_DRILL_MISSING: scripts/restore-drill.ps1 absent")
    powershell = _powershell_executable()
    with tempfile.TemporaryDirectory(prefix="w1f-restore-probe-") as tmp:
        tmp_path = Path(tmp)
        backup_directory = tmp_path / "backup"
        backup_directory.mkdir()
        manifest = {
            "format_version": 1,
            "database_name": "sswcenter_w1f_probe",
            "alembic_revision": revision,
            "dump_file": "database.dump",
            "dump_sha256": "0" * 64,
            "files": [],
            "restore_target_policy": "*_review only",
        }
        (backup_directory / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")
        # A review data root that does not yet exist and matches the sealed prefix
        # so the drill reaches the revision allowlist gate.
        review_data_root = tmp_path / f"sswcenter-restore-review-{uuid.uuid4().hex}"
        admin_url = "postgresql+psycopg://erp_owner@127.0.0.1:1/postgres"
        review_database = "sswcenter_w1f_probe_review"
        try:
            completed = subprocess.run(
                [
                    powershell,
                    "-NoProfile",
                    "-NonInteractive",
                    "-ExecutionPolicy",
                    "Bypass",
                    "-File",
                    str(RESTORE_DRILL),
                    "-BackupDirectory",
                    str(backup_directory),
                    "-AdminDatabaseUrl",
                    admin_url,
                    "-ReviewDatabaseName",
                    review_database,
                    "-ReviewDataRoot",
                    str(review_data_root),
                ],
                cwd=str(REPO_ROOT),
                capture_output=True,
                # PowerShell 5.1 emits localized (cp949) error formatting whose
                # bytes are not valid UTF-8; decode robustly so the ASCII markers
                # remain observable across locales instead of raising in the reader
                # thread and losing stdout/stderr. This preserves the node meaning.
                encoding="utf-8",
                errors="replace",
                timeout=120,
                check=False,
            )
        except (OSError, subprocess.TimeoutExpired):
            _fail("W1F_HARNESS_RESTORE_PROBE_UNRUNNABLE: restore-drill probe could not run")
        # The probe must never create the review data root before failing.
        if review_data_root.exists():
            _fail("W1F_HARNESS_RESTORE_PROBE_LEFT_DATA_ROOT: probe mutated the review root")
        return completed.returncode, completed.stdout + "\n" + completed.stderr


def test_w1f_restore_drill_accepts_w1d_manifest_revision() -> None:
    """Node 1: restore-drill must accept the W1D revision before artifact checks."""
    returncode, output = _run_restore_drill_manifest_probe(W1D_REVISION)
    if returncode == 0:
        _fail("W1F_RESTORE_W1D_PROBE_UNEXPECTED_SUCCESS: probe must fail on missing dump")
    if UNSUPPORTED_REVISION_MARKER in output:
        _fail(
            "W1F_RESTORE_W1D_REVISION_REJECTED: restore-drill rejects "
            + W1D_REVISION
            + " before artifact validation"
        )
    if ARTIFACT_STAGE_MARKER not in output:
        _fail(
            "W1F_RESTORE_W1D_ARTIFACT_STAGE_NOT_REACHED: restore-drill did not reach "
            "artifact validation for " + W1D_REVISION
        )


def test_w1f_restore_drill_accepts_w1e_manifest_revision() -> None:
    """Node 2: restore-drill must accept the W1E revision before artifact checks."""
    returncode, output = _run_restore_drill_manifest_probe(W1E_REVISION)
    if returncode == 0:
        _fail("W1F_RESTORE_W1E_PROBE_UNEXPECTED_SUCCESS: probe must fail on missing dump")
    if UNSUPPORTED_REVISION_MARKER in output:
        _fail(
            "W1F_RESTORE_W1E_REVISION_REJECTED: restore-drill rejects "
            + W1E_REVISION
            + " before artifact validation"
        )
    if ARTIFACT_STAGE_MARKER not in output:
        _fail(
            "W1F_RESTORE_W1E_ARTIFACT_STAGE_NOT_REACHED: restore-drill did not reach "
            "artifact validation for " + W1E_REVISION
        )


def test_w1f_restore_drill_accepts_continuing_education_manifest_revision() -> None:
    """Node 2a: restore-drill must accept the 0013 revision before artifact checks."""
    returncode, output = _run_restore_drill_manifest_probe(CONTINUING_EDUCATION_REVISION)
    if returncode == 0:
        _fail("W1F_RESTORE_0013_PROBE_UNEXPECTED_SUCCESS: probe must fail on missing dump")
    if UNSUPPORTED_REVISION_MARKER in output:
        _fail(
            "W1F_RESTORE_0013_REVISION_REJECTED: restore-drill rejects "
            + CONTINUING_EDUCATION_REVISION
            + " before artifact validation"
        )
    if ARTIFACT_STAGE_MARKER not in output:
        _fail(
            "W1F_RESTORE_0013_ARTIFACT_STAGE_NOT_REACHED: restore-drill did not reach "
            "artifact validation for " + CONTINUING_EDUCATION_REVISION
        )


def test_w1f_restore_drill_accepts_recipient_plan_notification_manifest_revision() -> None:
    """Node 2b: restore-drill must accept the 0014 revision before artifact checks."""
    returncode, output = _run_restore_drill_manifest_probe(RECIPIENT_PLAN_NOTIFICATION_REVISION)
    if returncode == 0:
        _fail("W1F_RESTORE_0014_PROBE_UNEXPECTED_SUCCESS: probe must fail on missing dump")
    if UNSUPPORTED_REVISION_MARKER in output:
        _fail(
            "W1F_RESTORE_0014_REVISION_REJECTED: restore-drill rejects "
            + RECIPIENT_PLAN_NOTIFICATION_REVISION
            + " before artifact validation"
        )
    if ARTIFACT_STAGE_MARKER not in output:
        _fail(
            "W1F_RESTORE_0014_ARTIFACT_STAGE_NOT_REACHED: restore-drill did not reach "
            "artifact validation for " + RECIPIENT_PLAN_NOTIFICATION_REVISION
        )


def test_w1f_restore_drill_accepts_recipient_status_tag_manifest_revision() -> None:
    """Node 2c: restore-drill must accept the 0015 current-head revision before artifacts."""
    returncode, output = _run_restore_drill_manifest_probe(RECIPIENT_STATUS_TAG_REVISION)
    if returncode == 0:
        _fail("W1F_RESTORE_0015_PROBE_UNEXPECTED_SUCCESS: probe must fail on missing dump")
    if UNSUPPORTED_REVISION_MARKER in output:
        _fail(
            "W1F_RESTORE_0015_REVISION_REJECTED: restore-drill rejects "
            + RECIPIENT_STATUS_TAG_REVISION
            + " before artifact validation"
        )
    if ARTIFACT_STAGE_MARKER not in output:
        _fail(
            "W1F_RESTORE_0015_ARTIFACT_STAGE_NOT_REACHED: restore-drill did not reach "
            "artifact validation for " + RECIPIENT_STATUS_TAG_REVISION
        )


def test_w1f_postcheck_declares_w1d_w1e_revision_contract() -> None:
    """Node 3: postcheck must supply exact W1D/W1E/0013/0014/0015 verifiers and markers."""
    if not POSTCHECK.is_file():
        _fail("W1F_POSTCHECK_MODULE_MISSING: backend/app/db/postcheck_w1a_vs1.py absent")
    source = POSTCHECK.read_text(encoding="utf-8")
    required_tokens = {
        "W1F_POSTCHECK_W1D_REVISION_MISSING": f'"{W1D_REVISION}"',
        "W1F_POSTCHECK_W1E_REVISION_MISSING": f'"{W1E_REVISION}"',
        "W1F_POSTCHECK_W1D_MARKER_MISSING": W1D_MARKER,
        "W1F_POSTCHECK_W1E_MARKER_MISSING": W1E_MARKER,
        "W1F_POSTCHECK_W1D_VERIFIER_MISSING": "def _verify_w1d_contract",
        "W1F_POSTCHECK_W1E_VERIFIER_MISSING": "def _verify_w1e_contract",
        "W1F_POSTCHECK_W1D_TABLE_MISSING": "recipient_contract",
        "W1F_POSTCHECK_W1E_TABLE_MISSING": "care_assignment",
        "W1F_POSTCHECK_W1E_RECIPIENT_REVERSE_TRIGGER_MISSING": (
            "ct_recipient_contract_assignment_reverse_guard"
        ),
        "W1F_POSTCHECK_W1E_POSITION_REVERSE_TRIGGER_MISSING": (
            "ct_staff_position_care_assignment_reverse_guard"
        ),
        "W1F_POSTCHECK_W1E_QUALIFICATION_REVERSE_TRIGGER_MISSING": (
            "ct_staff_service_qualification_assignment_reverse_guard"
        ),
        "W1F_POSTCHECK_W1E_TRIGGER_FUNCTION_BINDING_MISSING": "tgfoid",
        "W1F_POSTCHECK_REVISION_TRIGGER_SET_MISSING": "expected_w1a_triggers",
        "W1F_POSTCHECK_0013_REVISION_MISSING": f'"{CONTINUING_EDUCATION_REVISION}"',
        "W1F_POSTCHECK_0013_MARKER_MISSING": CONTINUING_EDUCATION_MARKER,
        "W1F_POSTCHECK_0014_REVISION_MISSING": f'"{RECIPIENT_PLAN_NOTIFICATION_REVISION}"',
        "W1F_POSTCHECK_0014_MARKER_MISSING": RECIPIENT_PLAN_NOTIFICATION_MARKER,
        "W1F_POSTCHECK_0014_VERIFIER_MISSING": "def _verify_recipient_plan_notification_contract",
        "W1F_POSTCHECK_0014_TABLE_MISSING": "recipient_plan_notification",
        "W1F_POSTCHECK_0014_LINEAGE_MISSING": "W1E_LINEAGE_REVISIONS",
        "W1F_POSTCHECK_0015_REVISION_MISSING": f'"{RECIPIENT_STATUS_TAG_REVISION}"',
        "W1F_POSTCHECK_0015_MARKER_MISSING": RECIPIENT_STATUS_TAG_MARKER,
        "W1F_POSTCHECK_0015_VERIFIER_MISSING": "def _verify_recipient_status_tag_contract",
        "W1F_POSTCHECK_0015_COLUMN_MISSING": "recipient_status",
    }
    for marker, token in required_tokens.items():
        if token not in source:
            _fail(f"{marker}: missing {token}")


def test_w1f_restore_drill_fail_closed_markers_for_0011_through_0015() -> None:
    """Preserve exact-revision fail-closed postcheck markers for 0011~0015."""
    if not RESTORE_DRILL.is_file():
        _fail("W1F_HARNESS_RESTORE_DRILL_MISSING: scripts/restore-drill.ps1 absent")
    source = RESTORE_DRILL.read_text(encoding="utf-8")
    required = (
        (W1D_REVISION, W1D_MARKER, "W1F_RESTORE_W1D_MARKER_FAIL_CLOSED_MISSING"),
        (W1E_REVISION, W1E_MARKER, "W1F_RESTORE_W1E_MARKER_FAIL_CLOSED_MISSING"),
        (
            CONTINUING_EDUCATION_REVISION,
            CONTINUING_EDUCATION_MARKER,
            "W1F_RESTORE_0013_MARKER_FAIL_CLOSED_MISSING",
        ),
        (
            RECIPIENT_PLAN_NOTIFICATION_REVISION,
            RECIPIENT_PLAN_NOTIFICATION_MARKER,
            "W1F_RESTORE_0014_MARKER_FAIL_CLOSED_MISSING",
        ),
        (
            RECIPIENT_STATUS_TAG_REVISION,
            RECIPIENT_STATUS_TAG_MARKER,
            "W1F_RESTORE_0015_MARKER_FAIL_CLOSED_MISSING",
        ),
    )
    for revision, marker, fail_marker in required:
        if revision not in source:
            _fail(f"{fail_marker}: revision {revision} not in restore-drill allowlist")
        if marker not in source:
            _fail(f"{fail_marker}: marker {marker} not enforced")
        # Fail-closed: exact revision equality AND -notcontains marker.
        pattern = (
            rf"\$ManifestRevision\s+-eq\s+\"{re.escape(revision)}\"\s+-and\s+"
            rf"\$PostcheckOutput\s+-notcontains\s+\"{re.escape(marker)}\""
        )
        if re.search(pattern, source) is None:
            _fail(
                f"{fail_marker}: restore-drill does not fail-closed on missing "
                f"{marker} for {revision}"
            )


def test_w1f_postgres_gate_contract_is_sealed() -> None:
    """Node 4: the exact-SHA synthetic backup/restore live gate must be sealed."""
    if not W1F_WRAPPER.is_file():
        _fail("W1F_WRAPPER_MISSING: scripts/test-w1f-postgres.ps1 absent")
    source = W1F_WRAPPER.read_text(encoding="utf-8")
    required_tokens = {
        "W1F_WRAPPER_EXPECTED_SHA_MISSING": "$ExpectedSha",
        "W1F_WRAPPER_EXACT_SHA_GATE_MISSING": "W1F_EXACT_SHA_OK",
        "W1F_WRAPPER_BACKUP_STEP_MISSING": "backup-postgres.ps1",
        "W1F_WRAPPER_RESTORE_STEP_MISSING": "restore-drill.ps1",
        "W1F_WRAPPER_W1D_MARKER_MISSING": W1D_MARKER,
        "W1F_WRAPPER_0015_MARKER_MISSING": RECIPIENT_STATUS_TAG_MARKER,
        "W1F_WRAPPER_CURRENT_HEAD_MISSING": f'$CurrentHead = "{CURRENT_HEAD}"',
        "W1F_WRAPPER_W1D_HEAD_MISSING": f'$W1dHead = "{W1D_REVISION}"',
        "W1F_WRAPPER_DOWNGRADE_STEP_MISSING": "W1F_STAGE_DOWNGRADE",
        "W1F_WRAPPER_REUPGRADE_STEP_MISSING": "W1F_STAGE_REUPGRADE",
        "W1F_WRAPPER_OFFLINE_STEP_MISSING": "W1F_STAGE_OFFLINE",
        "W1F_WRAPPER_CANONICAL_HASH_MISSING": "W1F_CANONICAL",
        "W1F_WRAPPER_FILE_HASH_MISSING": "Get-FileHash",
        "W1F_WRAPPER_SYNTHETIC_W1A_MISSING": "staff_service_qualification_period",
        "W1F_WRAPPER_CONTRACT_TABLE_MISSING": "recipient_contract",
        "W1F_WRAPPER_ASSIGNMENT_TABLE_MISSING": "care_assignment",
        "W1F_WRAPPER_0013_SEED_MISSING": "CONTINUING_EDUCATION",
        "W1F_WRAPPER_0013_FACT_TABLE_MISSING": "staff_periodic_training_status",
        "W1F_WRAPPER_0014_SEED_MISSING": "recipient_plan_notification",
        "W1F_WRAPPER_0015_STATUS_SEED_MISSING": "recipient_status",
        "W1F_WRAPPER_CLEANUP_MISSING": "W1F_CLEANUP",
        "W1F_WRAPPER_GREEN_MARKER_MISSING": "W1F_POSTGRES_GREEN",
        "W1F_WRAPPER_PRODUCT_FAILURE_FLAG_NOT_SET": "$script:ProductFailure = $true",
        "W1F_WRAPPER_PRODUCT_FAILURE_BRANCH_MISSING": "elseif ($ProductFailure)",
        "W1F_WRAPPER_STDOUT_UTF8_MISSING": "StandardOutputEncoding = $utf8NoBom",
        "W1F_WRAPPER_STDERR_UTF8_MISSING": "StandardErrorEncoding = $utf8NoBom",
    }
    for marker, token in required_tokens.items():
        if token not in source:
            _fail(f"{marker}: missing {token}")

    # Fresh / re-upgrade / offline must target $CurrentHead, not a stale W1E head.
    for stage_marker, stage_pattern in {
        "W1F_WRAPPER_BASE_UPGRADE_NOT_CURRENT_HEAD": (
            r'Invoke-W1fAlembic\s+-AlembicArgs\s+@\("upgrade",\s*\$CurrentHead\)'
            r"\s+-Marker\s+\"W1F_HARNESS_BASE_UPGRADE_FAILED\""
        ),
        "W1F_WRAPPER_REUPGRADE_NOT_CURRENT_HEAD": (
            r'Invoke-W1fAlembic\s+-AlembicArgs\s+@\("upgrade",\s*\$CurrentHead\)'
            r"\s+-Marker\s+\"W1F_HARNESS_REUPGRADE_FAILED\""
        ),
        "W1F_WRAPPER_OFFLINE_NOT_CURRENT_HEAD": (r"\$OfflineRevision\s+-ne\s+\$CurrentHead"),
        "W1F_WRAPPER_HEAD_REVISION_NOT_CURRENT_HEAD": (r"\$HeadRevision\s+-ne\s+\$CurrentHead"),
        "W1F_WRAPPER_REUPGRADE_REVISION_NOT_CURRENT_HEAD": (
            r"\$ReupgradeRevision\s+-ne\s+\$CurrentHead"
        ),
    }.items():
        if re.search(stage_pattern, source) is None:
            _fail(stage_marker)

    # W1D boundary downgrade is preserved.
    if (
        re.search(
            r'Invoke-W1fAlembic\s+-AlembicArgs\s+@\("downgrade",\s*\$W1dHead\)',
            source,
        )
        is None
    ):
        _fail("W1F_WRAPPER_W1D_DOWNGRADE_LOST")

    seed_match = re.search(
        r"(?ms)^\$SeedSql = @'\r?\n(?P<sql>.*?)\r?\n'@$",
        source,
    )
    if seed_match is None:
        _fail("W1F_WRAPPER_SEED_SQL_BLOCK_MISSING")
    seed_sql = seed_match.group("sql")
    if "CONTINUING_EDUCATION" not in seed_sql:
        _fail("W1F_WRAPPER_0013_SEED_CONTINUING_EDUCATION_MISSING")
    if "staff_periodic_training_status" not in seed_sql:
        _fail("W1F_WRAPPER_0013_SEED_TABLE_MISSING")
    if "recipient_plan_notification" not in seed_sql:
        _fail("W1F_WRAPPER_0014_SEED_TABLE_MISSING")
    if "recipient_status" not in seed_sql:
        _fail("W1F_WRAPPER_0015_RECIPIENT_STATUS_SEED_MISSING")
    if (
        re.search(
            r"INSERT\s+INTO\s+erp\.recipient\b[\s\S]*?recipient_status",
            seed_sql,
            flags=re.IGNORECASE,
        )
        is None
    ):
        _fail("W1F_WRAPPER_0015_RECIPIENT_STATUS_NOT_IN_INSERT")

    canonical_match = re.search(
        r"(?ms)^\$CanonicalSql = @'\r?\n(?P<sql>.*?)\r?\n'@$",
        source,
    )
    if canonical_match is None:
        _fail("W1F_WRAPPER_CANONICAL_SQL_BLOCK_MISSING")
    canonical_sql = canonical_match.group("sql")
    required_canonical_tables = (
        "staff",
        "user_account",
        "staff_employment",
        "staff_position_period",
        "staff_license",
        "staff_service_qualification_period",
        "staff_onboarding_training",
        "staff_periodic_training_status",
        "recipient",
        "recipient_contract",
        "care_assignment",
        "recipient_plan_notification",
    )
    for table_name in required_canonical_tables:
        full_row_pattern = (
            rf"SELECT\s+'{re.escape(table_name)}:'\s*\|\|\s*"
            rf"to_jsonb\([a-z_][a-z0-9_]*\)::text\s+AS\s+line\s+"
            rf"FROM\s+erp\.{re.escape(table_name)}\s+AS\s+[a-z_][a-z0-9_]*"
        )
        if re.search(full_row_pattern, canonical_sql, flags=re.IGNORECASE) is None:
            _fail(
                "W1F_WRAPPER_CANONICAL_FULL_ROW_MISSING: "
                f"erp.{table_name} is not hashed with to_jsonb(row)"
            )

    # recipient full-row hash necessarily includes 0015 recipient_status column.
    recipient_full_row = re.search(
        r"SELECT\s+'recipient:'\s*\|\|\s*to_jsonb\(([a-z_][a-z0-9_]*)\)::text\s+AS\s+line\s+"
        r"FROM\s+erp\.recipient\s+AS\s+\1",
        canonical_sql,
        flags=re.IGNORECASE,
    )
    if recipient_full_row is None:
        _fail(
            "W1F_WRAPPER_0015_STATUS_NOT_IN_FULL_ROW_HASH: "
            "erp.recipient is not hashed with to_jsonb(row) so recipient_status is not sealed"
        )

    function_start = source.find("function Write-W1fProductFailure {")
    function_end = source.find("function Get-W1fProcessSnapshot {", function_start + 1)
    if function_start < 0 or function_end < 0:
        _fail("W1F_WRAPPER_PRODUCT_FAILURE_FUNCTION_MISSING")
    function_body = source[function_start:function_end]
    flag_position = function_body.find("$script:ProductFailure = $true")
    throw_position = function_body.find("throw $Marker")
    if flag_position < 0 or throw_position < 0 or flag_position > throw_position:
        _fail("W1F_WRAPPER_PRODUCT_FAILURE_FLAG_ORDER_INVALID")

    timed_start = source.find("function Invoke-W1fTimedCommand {")
    timed_end = source.find("function Invoke-W1fDetachedPgCtlStart {", timed_start + 1)
    if timed_start < 0 or timed_end < 0:
        _fail("W1F_WRAPPER_TIMED_COMMAND_FUNCTION_MISSING")
    timed_body = source[timed_start:timed_end]
    for marker, token in {
        "W1F_WRAPPER_STDOUT_UTF8_OUTSIDE_TIMED_COMMAND": ("StandardOutputEncoding = $utf8NoBom"),
        "W1F_WRAPPER_STDERR_UTF8_OUTSIDE_TIMED_COMMAND": ("StandardErrorEncoding = $utf8NoBom"),
    }.items():
        if token not in timed_body:
            _fail(f"{marker}: missing {token}")


def test_w1f_w1c_restore_and_marker_regression() -> None:
    """Node 5 (ABS): existing W1C restore support and marker must be preserved."""
    if not RESTORE_DRILL.is_file():
        _fail("W1F_HARNESS_RESTORE_DRILL_MISSING: scripts/restore-drill.ps1 absent")
    if not POSTCHECK.is_file():
        _fail("W1F_POSTCHECK_MODULE_MISSING: backend/app/db/postcheck_w1a_vs1.py absent")
    restore_source = RESTORE_DRILL.read_text(encoding="utf-8")
    postcheck_source = POSTCHECK.read_text(encoding="utf-8")
    if W1C_REVISION not in restore_source:
        _fail("W1F_W1C_RESTORE_SUPPORT_LOST: restore-drill dropped the W1C revision")
    if "W1C_DB_POSTCHECK_OK" not in restore_source:
        _fail("W1F_W1C_RESTORE_MARKER_LOST: restore-drill dropped the W1C marker enforcement")
    if f'"{W1C_REVISION}"' not in postcheck_source:
        _fail("W1F_W1C_POSTCHECK_SUPPORT_LOST: postcheck dropped the W1C revision")
    if "W1C_DB_POSTCHECK_OK" not in postcheck_source:
        _fail("W1F_W1C_POSTCHECK_MARKER_LOST: postcheck dropped the W1C marker")


def test_w1f_w1c_wrapper_seals_0010_lifecycle_then_upgrades_to_head() -> None:
    """W1C historical wrapper must seal 0010 lifecycle, then upgrade to head before ORM pytest."""
    if not W1C_WRAPPER.is_file():
        _fail("W1F_W1C_WRAPPER_MISSING: scripts/test-w1c-postgres.ps1 absent")
    source = W1C_WRAPPER.read_text(encoding="utf-8")

    required_tokens = {
        "W1F_W1C_WRAPPER_BASE_REVISION_MISSING": f'$BaseRevision = "{W1B_REVISION}"',
        "W1F_W1C_WRAPPER_EXPECTED_REVISION_MISSING": f'$ExpectedRevision = "{W1C_REVISION}"',
        "W1F_W1C_WRAPPER_BASE_UPGRADE_MISSING": "W1C_HARNESS_BASE_UPGRADE_FAILED",
        "W1F_W1C_WRAPPER_UPGRADE_MISSING": "W1C_HARNESS_UPGRADE_FAILED",
        "W1F_W1C_WRAPPER_DOWNGRADE_MISSING": "W1C_HARNESS_DOWNGRADE_FAILED",
        "W1F_W1C_WRAPPER_REUPGRADE_MISSING": "W1C_HARNESS_REUPGRADE_FAILED",
        "W1F_W1C_WRAPPER_REVISION_ASSERT_MISSING": "W1C_HARNESS_REVISION_MISMATCH",
        "W1F_W1C_WRAPPER_HEAD_UPGRADE_FAIL_CLOSED_MISSING": "W1C_HARNESS_HEAD_UPGRADE_FAILED",
        "W1F_W1C_WRAPPER_HEAD_UPGRADE_MARKER_MISSING": "W1C_HEAD_UPGRADE_OK",
        "W1F_W1C_WRAPPER_PYTEST_MISSING": "tests/test_w1c_postgres.py",
        "W1F_W1C_WRAPPER_HEAD_POSTCHECK_MARKER_MISSING": RECIPIENT_STATUS_TAG_MARKER,
        "W1F_W1C_WRAPPER_GREEN_MISSING": "W1C_POSTGRES_GREEN",
    }
    for marker, token in required_tokens.items():
        if token not in source:
            _fail(f"{marker}: missing {token}")

    lifecycle_patterns = (
        (
            "W1F_W1C_WRAPPER_BASE_UPGRADE_CALL_MISSING",
            r"alembic\s+-c\s+alembic\.ini\s+upgrade\s+\$BaseRevision",
        ),
        (
            "W1F_W1C_WRAPPER_EXPECTED_UPGRADE_CALL_MISSING",
            r"alembic\s+-c\s+alembic\.ini\s+upgrade\s+\$ExpectedRevision",
        ),
        (
            "W1F_W1C_WRAPPER_DOWNGRADE_CALL_MISSING",
            r"alembic\s+-c\s+alembic\.ini\s+downgrade\s+\$BaseRevision",
        ),
        (
            "W1F_W1C_WRAPPER_REUPGRADE_CALL_MISSING",
            r"alembic\s+-c\s+alembic\.ini\s+upgrade\s+\$ExpectedRevision",
        ),
        (
            "W1F_W1C_WRAPPER_HEAD_UPGRADE_CALL_MISSING",
            r"alembic\s+-c\s+alembic\.ini\s+upgrade\s+head\b",
        ),
        (
            "W1F_W1C_WRAPPER_EXACT_0010_ASSERT_MISSING",
            r"\$CurrentRevision\s+-join\s+\"\"\)\.Trim\(\)\s+-ne\s+\$ExpectedRevision",
        ),
    )
    for marker, pattern in lifecycle_patterns:
        if re.search(pattern, source) is None:
            _fail(marker)

    revision_assert_at = source.find("W1C_HARNESS_REVISION_MISMATCH")
    head_upgrade_fail_at = source.find("W1C_HARNESS_HEAD_UPGRADE_FAILED")
    head_upgrade_ok_at = source.find("W1C_HEAD_UPGRADE_OK")
    pytest_at = source.find("tests/test_w1c_postgres.py")
    postcheck_at = source.find("app.db.postcheck_w1a_vs1")
    if (
        min(revision_assert_at, head_upgrade_fail_at, head_upgrade_ok_at, pytest_at, postcheck_at)
        < 0
    ):
        _fail("W1F_W1C_WRAPPER_STAGE_MARKERS_INCOMPLETE")
    if not (
        revision_assert_at < head_upgrade_fail_at < head_upgrade_ok_at < pytest_at < postcheck_at
    ):
        _fail(
            "W1F_W1C_WRAPPER_HEAD_UPGRADE_ORDER_INVALID: "
            "exact 0010 assertion must precede fail-closed head upgrade, "
            "W1C_HEAD_UPGRADE_OK, current ORM pytest, and postcheck"
        )

    head_upgrade_block = source[revision_assert_at:pytest_at]
    if "upgrade head" not in head_upgrade_block:
        _fail("W1F_W1C_WRAPPER_HEAD_UPGRADE_NOT_BETWEEN_0010_AND_PYTEST")
    if "W1C_HARNESS_HEAD_UPGRADE_FAILED" not in head_upgrade_block:
        _fail("W1F_W1C_WRAPPER_HEAD_UPGRADE_FAIL_CLOSED_NOT_BETWEEN_0010_AND_PYTEST")
    if "W1C_HEAD_UPGRADE_OK" not in head_upgrade_block:
        _fail("W1F_W1C_WRAPPER_HEAD_UPGRADE_MARKER_NOT_BETWEEN_0010_AND_PYTEST")


def test_w1f_plan_notification_e2e_hides_detector_visible_resident_number() -> None:
    """0014 real-PG E2E must keep the fixture RRN without a detector-visible source candidate."""
    if not PLAN_NOTIFICATION_E2E.is_file():
        _fail(
            "W1F_PLAN_NOTIFICATION_E2E_MISSING: "
            "frontend/e2e/recipient-plan-notification-real-pg.spec.ts absent"
        )
    source = PLAN_NOTIFICATION_E2E.read_text(encoding="utf-8")

    # Existing W1A detector must treat the sealed contiguous fixture as sensitive.
    if _w1a_rrn_match_count(PLAN_NOTIFICATION_SYNTHETIC_RRN) < 1:
        _fail(
            "W1F_PLAN_NOTIFICATION_RRN_DETECTOR_BLIND: "
            "sealed synthetic fixture is not detector-visible when contiguous"
        )
    # The tracked E2E source must no longer present that contiguous candidate.
    if _w1a_rrn_match_count(source) != 0:
        _fail(
            "W1F_PLAN_NOTIFICATION_E2E_RRN_CANDIDATE_VISIBLE: "
            "recipient-plan-notification-real-pg.spec.ts still contains a "
            "detector-visible resident-number candidate"
        )

    # Runtime construction remains deterministic from separately quoted fragments.
    fragment_pattern = r"(['\"])90010\1\s*\+\s*(['\"])1-11234\2\s*\+\s*(['\"])99\3"
    if re.search(fragment_pattern, source) is None:
        _fail(
            "W1F_PLAN_NOTIFICATION_E2E_RRN_FRAGMENT_CONSTRUCTION_MISSING: "
            "expected separately quoted fragments that join to the sealed fixture"
        )
    if PLAN_NOTIFICATION_SYNTHETIC_RRN != ("90010" + "1-11234" + "99"):
        _fail("W1F_PLAN_NOTIFICATION_E2E_RRN_FIXTURE_DRIFT")
    if "SYNTHETIC_STAFF_RESIDENT_NUMBER" not in source:
        _fail("W1F_PLAN_NOTIFICATION_E2E_RRN_CONSTANT_MISSING")
    if "resident_number: SYNTHETIC_STAFF_RESIDENT_NUMBER" not in source:
        _fail("W1F_PLAN_NOTIFICATION_E2E_RRN_USAGE_MISSING")


def test_w1f_current_head_and_lineage_constants_contract() -> None:
    """Current-head/marker contract: wrapper + restore/postcheck agree on 0015 head."""
    if not W1F_WRAPPER.is_file():
        _fail("W1F_WRAPPER_MISSING: scripts/test-w1f-postgres.ps1 absent")
    if not RESTORE_DRILL.is_file():
        _fail("W1F_HARNESS_RESTORE_DRILL_MISSING: scripts/restore-drill.ps1 absent")
    if not POSTCHECK.is_file():
        _fail("W1F_POSTCHECK_MODULE_MISSING: backend/app/db/postcheck_w1a_vs1.py absent")

    wrapper = W1F_WRAPPER.read_text(encoding="utf-8")
    restore = RESTORE_DRILL.read_text(encoding="utf-8")
    postcheck = POSTCHECK.read_text(encoding="utf-8")

    if f'$CurrentHead = "{CURRENT_HEAD}"' not in wrapper:
        _fail("W1F_CURRENT_HEAD_WRAPPER_MISMATCH")
    if CURRENT_HEAD not in restore:
        _fail("W1F_CURRENT_HEAD_RESTORE_SUPPORT_MISSING")
    if f'RECIPIENT_STATUS_TAG_REVISION = "{CURRENT_HEAD}"' not in postcheck:
        _fail("W1F_CURRENT_HEAD_POSTCHECK_REVISION_MISSING")
    if RECIPIENT_STATUS_TAG_MARKER not in postcheck:
        _fail("W1F_CURRENT_HEAD_POSTCHECK_MARKER_MISSING")
    if RECIPIENT_STATUS_TAG_MARKER not in restore:
        _fail("W1F_CURRENT_HEAD_RESTORE_MARKER_MISSING")
    if RECIPIENT_STATUS_TAG_MARKER not in wrapper:
        _fail("W1F_CURRENT_HEAD_WRAPPER_MARKER_MISSING")

    # Lineage 0011~0014 constants remain present on the wrapper for preservation.
    for name, revision in (
        ("$W1dHead", W1D_REVISION),
        ("$W1eHead", W1E_REVISION),
        ("$ContinuingEducationHead", CONTINUING_EDUCATION_REVISION),
        ("$RecipientPlanNotificationHead", RECIPIENT_PLAN_NOTIFICATION_REVISION),
    ):
        if f'{name} = "{revision}"' not in wrapper:
            _fail(f"W1F_LINEAGE_HEAD_CONSTANT_MISSING: {name}={revision}")

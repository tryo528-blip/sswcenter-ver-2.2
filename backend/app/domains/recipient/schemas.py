from __future__ import annotations

from datetime import date, datetime
from enum import StrEnum
from typing import Annotated, Any

from pydantic import BaseModel, ConfigDict, Field


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True)


class RecipientSexCode(StrEnum):
    MALE = "MALE"
    FEMALE = "FEMALE"


PositiveVersion = Annotated[int, Field(gt=0)]


class RecipientCreateRequest(StrictModel):
    name: str = Field(min_length=1, max_length=200)
    birth_date: date
    sex_code: RecipientSexCode
    postal_code: str | None = Field(default=None, max_length=50)
    address: str | None = Field(default=None, max_length=1000)
    home_phone: str | None = Field(default=None, max_length=100)
    mobile_phone: str | None = Field(default=None, max_length=100)
    memo: str | None = Field(default=None, max_length=4000)


class RecipientUpdateRequest(StrictModel):
    expected_row_version: PositiveVersion
    name: str | None = Field(default=None, min_length=1, max_length=200)
    birth_date: date | None = None
    sex_code: RecipientSexCode | None = None
    postal_code: str | None = Field(default=None, max_length=50)
    address: str | None = Field(default=None, max_length=1000)
    home_phone: str | None = Field(default=None, max_length=100)
    mobile_phone: str | None = Field(default=None, max_length=100)
    memo: str | None = Field(default=None, max_length=4000)


class RecipientResponse(StrictModel):
    id: int
    name: str
    birth_date: date
    sex_code: RecipientSexCode
    recipient_no: str | None
    postal_code: str | None
    address: str | None
    home_phone: str | None
    mobile_phone: str | None
    memo: str | None
    row_version: int


class RecipientListResponse(StrictModel):
    items: list[RecipientResponse]
    total: int = Field(ge=0)
    page: int = Field(ge=1)
    page_size: int = Field(ge=1)


class GuardianCreateRequest(StrictModel):
    name: str = Field(min_length=1, max_length=200)
    phone: str | None = Field(default=None, max_length=100)
    address: str | None = Field(default=None, max_length=1000)
    relationship_text: str | None = Field(default=None, max_length=200)


class GuardianUpdateRequest(StrictModel):
    expected_row_version: PositiveVersion
    name: str | None = Field(default=None, min_length=1, max_length=200)
    phone: str | None = Field(default=None, max_length=100)
    address: str | None = Field(default=None, max_length=1000)
    relationship_text: str | None = Field(default=None, max_length=200)


class GuardianResponse(StrictModel):
    id: int
    recipient_id: int
    name: str
    phone: str | None
    address: str | None
    relationship_text: str | None
    row_version: int


class GuardianListResponse(StrictModel):
    items: list[GuardianResponse]


class PrimaryGuardianPeriodCreateRequest(StrictModel):
    guardian_id: int = Field(gt=0)
    start_date: date
    end_date: date | None = None


class PrimaryGuardianPeriodReplacementRequest(StrictModel):
    expected_row_version: PositiveVersion
    guardian_id: int = Field(gt=0)
    start_date: date
    end_date: date | None = None


class HistoryInvalidateRequest(StrictModel):
    expected_row_version: PositiveVersion


class PrimaryGuardianPeriodResponse(StrictModel):
    id: int
    recipient_id: int
    guardian_id: int
    start_date: date
    end_date: date | None
    invalidated_at_utc: datetime | None
    replacement_primary_guardian_period_id: int | None
    row_version: int


class PrimaryGuardianPeriodListResponse(StrictModel):
    items: list[PrimaryGuardianPeriodResponse]


class PrimaryGuardianPeriodReplacementResponse(StrictModel):
    original: PrimaryGuardianPeriodResponse
    replacement: PrimaryGuardianPeriodResponse


class PayerSnapshotCreateRequest(StrictModel):
    name: str = Field(min_length=1, max_length=200)
    start_date: date
    phone: str | None = Field(default=None, max_length=100)
    address: str | None = Field(default=None, max_length=1000)
    relationship_text: str | None = Field(default=None, max_length=200)
    end_date: date | None = None


class PayerSnapshotReplacementRequest(StrictModel):
    expected_row_version: PositiveVersion
    name: str = Field(min_length=1, max_length=200)
    start_date: date
    phone: str | None = Field(default=None, max_length=100)
    address: str | None = Field(default=None, max_length=1000)
    relationship_text: str | None = Field(default=None, max_length=200)
    end_date: date | None = None


class PayerSnapshotResponse(StrictModel):
    id: int
    recipient_id: int
    name: str
    phone: str | None
    address: str | None
    relationship_text: str | None
    start_date: date
    end_date: date | None
    invalidated_at_utc: datetime | None
    replacement_payer_snapshot_id: int | None
    row_version: int


class PayerSnapshotListResponse(StrictModel):
    items: list[PayerSnapshotResponse]


class PayerSnapshotReplacementResponse(StrictModel):
    original: PayerSnapshotResponse
    replacement: PayerSnapshotResponse


class PlanNotificationCreateRequest(StrictModel):
    notified_date: date


class PlanNotificationResponse(StrictModel):
    id: int
    recipient_id: int
    notified_date: date
    invalidated_at_utc: datetime | None
    row_version: int


class PlanNotificationListResponse(StrictModel):
    items: list[PlanNotificationResponse]


class RecipientDeadlineKind(StrEnum):
    CERTIFICATION_EXPIRY = "CERTIFICATION_EXPIRY"
    CONTRACT_EXPIRY = "CONTRACT_EXPIRY"
    PLAN_RENEWAL = "PLAN_RENEWAL"


class RecipientDeadlineItem(StrictModel):
    recipient_id: int
    recipient_name: str
    kind: RecipientDeadlineKind
    source_id: int | None
    source_date: date
    due_date: date


class RecipientDeadlineListResponse(StrictModel):
    items: list[RecipientDeadlineItem]


class RecipientErrorField(StrictModel):
    field: str
    message: str


class RecipientErrorBody(StrictModel):
    code: str
    message: str


class RecipientErrorEnvelope(StrictModel):
    error: RecipientErrorBody
    field_errors: list[RecipientErrorField]
    details: dict[str, Any]
    request_id: str

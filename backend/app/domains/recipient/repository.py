from __future__ import annotations

from sqlalchemy import func, or_, select
from sqlalchemy.orm import Session

from app.db.models import (
    Recipient,
    RecipientGuardian,
    RecipientGuardianPrimaryPeriod,
    RecipientPayerSnapshot,
    RecipientPlanNotification,
)


class RecipientRepository:
    def __init__(self, database_session: Session) -> None:
        self.database_session = database_session

    def add(self, instance: object) -> None:
        self.database_session.add(instance)

    def flush(self) -> None:
        self.database_session.flush()

    def get_recipient(self, recipient_id: int, *, for_update: bool = False) -> Recipient | None:
        statement = select(Recipient).where(Recipient.id == recipient_id)
        if for_update:
            statement = statement.with_for_update()
        return self.database_session.scalar(statement)

    def list_recipients(
        self,
        *,
        search: str | None,
        offset: int,
        limit: int,
    ) -> tuple[list[Recipient], int]:
        statement = select(Recipient)
        count_statement = select(func.count()).select_from(Recipient)
        if search:
            escaped = search.strip().replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
            pattern = f"%{escaped}%"
            predicate = or_(
                Recipient.name.ilike(pattern, escape="\\"),
                Recipient.recipient_no.ilike(pattern, escape="\\"),
            )
            statement = statement.where(predicate)
            count_statement = count_statement.where(predicate)
        total = int(self.database_session.scalar(count_statement) or 0)
        items = list(
            self.database_session.scalars(
                statement.order_by(Recipient.name.asc(), Recipient.id.asc())
                .offset(offset)
                .limit(limit)
            )
        )
        return items, total

    def get_guardian(
        self,
        recipient_id: int,
        guardian_id: int,
        *,
        for_update: bool = False,
    ) -> RecipientGuardian | None:
        statement = select(RecipientGuardian).where(
            RecipientGuardian.id == guardian_id,
            RecipientGuardian.recipient_id == recipient_id,
        )
        if for_update:
            statement = statement.with_for_update()
        return self.database_session.scalar(statement)

    def list_guardians(self, recipient_id: int) -> list[RecipientGuardian]:
        return list(
            self.database_session.scalars(
                select(RecipientGuardian)
                .where(RecipientGuardian.recipient_id == recipient_id)
                .order_by(RecipientGuardian.id.asc())
            )
        )

    def get_primary_period(
        self,
        recipient_id: int,
        period_id: int,
        *,
        for_update: bool = False,
        active_only: bool = False,
    ) -> RecipientGuardianPrimaryPeriod | None:
        statement = select(RecipientGuardianPrimaryPeriod).where(
            RecipientGuardianPrimaryPeriod.id == period_id,
            RecipientGuardianPrimaryPeriod.recipient_id == recipient_id,
        )
        if active_only:
            statement = statement.where(RecipientGuardianPrimaryPeriod.invalidated_at_utc.is_(None))
        if for_update:
            statement = statement.with_for_update()
        return self.database_session.scalar(statement)

    def list_primary_periods(self, recipient_id: int) -> list[RecipientGuardianPrimaryPeriod]:
        return list(
            self.database_session.scalars(
                select(RecipientGuardianPrimaryPeriod)
                .where(RecipientGuardianPrimaryPeriod.recipient_id == recipient_id)
                .order_by(
                    RecipientGuardianPrimaryPeriod.start_date.desc(),
                    RecipientGuardianPrimaryPeriod.id.desc(),
                )
            )
        )

    def get_payer_snapshot(
        self,
        recipient_id: int,
        snapshot_id: int,
        *,
        for_update: bool = False,
        active_only: bool = False,
    ) -> RecipientPayerSnapshot | None:
        statement = select(RecipientPayerSnapshot).where(
            RecipientPayerSnapshot.id == snapshot_id,
            RecipientPayerSnapshot.recipient_id == recipient_id,
        )
        if active_only:
            statement = statement.where(RecipientPayerSnapshot.invalidated_at_utc.is_(None))
        if for_update:
            statement = statement.with_for_update()
        return self.database_session.scalar(statement)

    def list_payer_snapshots(self, recipient_id: int) -> list[RecipientPayerSnapshot]:
        return list(
            self.database_session.scalars(
                select(RecipientPayerSnapshot)
                .where(RecipientPayerSnapshot.recipient_id == recipient_id)
                .order_by(
                    RecipientPayerSnapshot.start_date.desc(),
                    RecipientPayerSnapshot.id.desc(),
                )
            )
        )

    def get_plan_notification(
        self,
        recipient_id: int,
        notification_id: int,
        *,
        for_update: bool = False,
        active_only: bool = False,
    ) -> RecipientPlanNotification | None:
        statement = select(RecipientPlanNotification).where(
            RecipientPlanNotification.id == notification_id,
            RecipientPlanNotification.recipient_id == recipient_id,
        )
        if active_only:
            statement = statement.where(RecipientPlanNotification.invalidated_at_utc.is_(None))
        if for_update:
            statement = statement.with_for_update()
        return self.database_session.scalar(statement)

    def list_plan_notifications(
        self,
        recipient_id: int,
    ) -> list[RecipientPlanNotification]:
        return list(
            self.database_session.scalars(
                select(RecipientPlanNotification)
                .where(RecipientPlanNotification.recipient_id == recipient_id)
                .order_by(
                    RecipientPlanNotification.notified_date.desc(),
                    RecipientPlanNotification.id.desc(),
                )
            )
        )

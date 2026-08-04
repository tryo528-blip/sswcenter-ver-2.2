import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import RecipientW1cPanel from '../components/recipients/RecipientW1cPanel';
import RecipientContractPanel from '../components/recipients/RecipientContractPanel';
import '../styles/recipients.css';
import { ApiError } from '../services/api';
import {
  createGuardian,
  createPrimaryGuardianPeriod,
  createPayerSnapshot,
  createPlanNotification,
  createRecipient,
  getRecipient,
  invalidatePayerSnapshot,
  invalidatePlanNotification,
  invalidatePrimaryGuardianPeriod,
  listGuardians,
  listPayerSnapshots,
  listPlanNotifications,
  listPrimaryGuardianPeriods,
  listRecipients,
  replacePayerSnapshot,
  replacePrimaryGuardianPeriod,
  updateGuardian,
  updateRecipient,
} from '../services/recipientApi';
import type {
  Guardian,
  GuardianCreateRequest,
  PayerSnapshot,
  PayerSnapshotCreateRequest,
  PayerSnapshotReplacementRequest,
  PlanNotification,
  PlanNotificationCreateRequest,
  PrimaryGuardianPeriod,
  PrimaryGuardianPeriodCreateRequest,
  PrimaryGuardianPeriodReplacementRequest,
  Recipient,
  RecipientCreateRequest,
  RecipientSexCode,
  RecipientUpdateRequest,
} from '../services/recipientApi';

type RecipientFormState = {
  name: string;
  birth_date: string;
  sex_code: RecipientSexCode;
  postal_code: string;
  address: string;
  home_phone: string;
  mobile_phone: string;
  memo: string;
};

type RecipientStaleConflict = {
  original: Recipient;
  latest: Recipient;
};

type GuardianFormState = {
  name: string;
  phone: string;
  address: string;
  relationship_text: string;
};

type PrimaryPeriodFormState = {
  guardian_id: string;
  start_date: string;
  end_date: string;
};

type PayerFormState = {
  name: string;
  phone: string;
  address: string;
  relationship_text: string;
  start_date: string;
  end_date: string;
};

type EmbeddedRecipient = Recipient & {
  guardians?: Guardian[];
};

const PAGE_SIZE = 100;

const emptyRecipientForm = (): RecipientFormState => ({
  name: '',
  birth_date: '',
  sex_code: 'MALE',
  postal_code: '',
  address: '',
  home_phone: '',
  mobile_phone: '',
  memo: '',
});

const emptyGuardianForm = (): GuardianFormState => ({
  name: '',
  phone: '',
  address: '',
  relationship_text: '',
});

const emptyPrimaryPeriodForm = (): PrimaryPeriodFormState => ({
  guardian_id: '',
  start_date: todayIso(),
  end_date: '',
});

const emptyPayerForm = (): PayerFormState => ({
  name: '',
  phone: '',
  address: '',
  relationship_text: '',
  start_date: todayIso(),
  end_date: '',
});

function optionalText(value: string): string | null {
  const normalized = value.trim();
  return normalized || null;
}

function recipientCreatePayload(form: RecipientFormState): RecipientCreateRequest {
  return {
    name: form.name.trim(),
    birth_date: form.birth_date,
    sex_code: form.sex_code,
    postal_code: optionalText(form.postal_code),
    address: optionalText(form.address),
    home_phone: optionalText(form.home_phone),
    mobile_phone: optionalText(form.mobile_phone),
    memo: optionalText(form.memo),
  };
}

function recipientUpdatePayload(
  form: RecipientFormState,
  expectedRowVersion: number,
): RecipientUpdateRequest {
  return {
    expected_row_version: expectedRowVersion,
    name: form.name.trim(),
    birth_date: form.birth_date,
    sex_code: form.sex_code,
    postal_code: optionalText(form.postal_code),
    address: optionalText(form.address),
    home_phone: optionalText(form.home_phone),
    mobile_phone: optionalText(form.mobile_phone),
    memo: optionalText(form.memo),
  };
}

function recipientFormFromRecipient(recipient: Recipient): RecipientFormState {
  return {
    name: recipient.name,
    birth_date: recipient.birth_date,
    sex_code: recipient.sex_code,
    postal_code: recipient.postal_code ?? '',
    address: recipient.address ?? '',
    home_phone: recipient.home_phone ?? '',
    mobile_phone: recipient.mobile_phone ?? '',
    memo: recipient.memo ?? '',
  };
}

function recipientReapplyPayload(
  original: Recipient,
  draft: RecipientFormState,
  expectedRowVersion: number,
): RecipientUpdateRequest {
  const payload: RecipientUpdateRequest = { expected_row_version: expectedRowVersion };
  if (draft.name.trim() !== original.name) payload.name = draft.name.trim();
  if (draft.birth_date !== original.birth_date) payload.birth_date = draft.birth_date;
  if (draft.sex_code !== original.sex_code) payload.sex_code = draft.sex_code;
  if (optionalText(draft.postal_code) !== original.postal_code) {
    payload.postal_code = optionalText(draft.postal_code);
  }
  if (optionalText(draft.address) !== original.address) {
    payload.address = optionalText(draft.address);
  }
  if (optionalText(draft.home_phone) !== original.home_phone) {
    payload.home_phone = optionalText(draft.home_phone);
  }
  if (optionalText(draft.mobile_phone) !== original.mobile_phone) {
    payload.mobile_phone = optionalText(draft.mobile_phone);
  }
  if (optionalText(draft.memo) !== original.memo) {
    payload.memo = optionalText(draft.memo);
  }
  return payload;
}

function guardianFormFromGuardian(guardian: Guardian): GuardianFormState {
  return {
    name: guardian.name,
    phone: guardian.phone ?? '',
    address: guardian.address ?? '',
    relationship_text: guardian.relationship_text ?? '',
  };
}

function guardianPayload(form: GuardianFormState): GuardianCreateRequest {
  return {
    name: form.name.trim(),
    phone: optionalText(form.phone),
    address: optionalText(form.address),
    relationship_text: optionalText(form.relationship_text),
  };
}

function primaryPeriodPayload(form: PrimaryPeriodFormState): PrimaryGuardianPeriodCreateRequest {
  return {
    guardian_id: Number.parseInt(form.guardian_id, 10),
    start_date: form.start_date,
    end_date: optionalText(form.end_date),
  };
}

function payerPayload(form: PayerFormState): PayerSnapshotCreateRequest {
  return {
    name: form.name.trim(),
    phone: optionalText(form.phone),
    address: optionalText(form.address),
    relationship_text: optionalText(form.relationship_text),
    start_date: form.start_date,
    end_date: optionalText(form.end_date),
  };
}

function valueFromResult<T>(result: PromiseSettledResult<T>): T | undefined {
  return result.status === 'fulfilled' ? result.value : undefined;
}

function isAbortError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'name' in error &&
    (error as { name?: unknown }).name === 'AbortError'
  );
}

function isApiErrorCode(error: unknown, code: string): boolean {
  const isKnownApiError =
    error instanceof ApiError ||
    (error instanceof Error && error.name === 'ApiError');
  return isKnownApiError && (error as { code?: string }).code === code;
}

function safeErrorMessage(error: unknown, fallback: string): string {
  const isKnownApiError =
    error instanceof ApiError ||
    (error instanceof Error && error.name === 'ApiError');
  if (isKnownApiError) {
    const code = (error as { code?: string }).code;
    if (code === 'ROW_VERSION_CONFLICT') {
      return '다른 사용자가 먼저 변경했습니다. 현재 입력은 유지되니 최신 정보를 확인한 뒤 다시 저장해주세요.';
    }
    if (code === 'PRIMARY_GUARDIAN_PERIOD_CONFLICT') {
      return '선택한 기간에 이미 유효한 대표 보호자 기간이 있습니다. 기간을 조정하거나 기존 기간을 교체해주세요.';
    }
    if (code === 'CURRENT_PAYER_CONFLICT') {
      return '현재 유효한 납부자가 있습니다. 기존 snapshot을 교체하거나 무효화한 뒤 다시 지정해주세요.';
    }
    if (error instanceof Error && error.message) return error.message;
  }
  return fallback;
}

function parsePage(rawValue: string | null): number {
  const parsed = Number.parseInt(rawValue ?? '1', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
}

function normalizeId(value: number | string | null | undefined): string | null {
  return value === null || value === undefined ? null : String(value);
}

function formatRecipientNo(value: string | null | undefined): string {
  return value?.trim() ? value : '미부여';
}

function formatNullable(value: string | null | undefined): string {
  return value?.trim() ? value : '없음';
}

function formatFullAge(birthDate: string): string {
  const parts = birthDate.slice(0, 10).split('-').map(Number);
  if (parts.length !== 3 || parts.some((part) => !Number.isInteger(part))) return '미확인';
  const [birthYear, birthMonth, birthDay] = parts;
  const today = new Date();
  let age = today.getFullYear() - birthYear;
  const birthdayPassed =
    today.getMonth() + 1 > birthMonth ||
    (today.getMonth() + 1 === birthMonth && today.getDate() >= birthDay);
  if (!birthdayPassed) age -= 1;
  return age >= 0 ? `${age}세` : '미확인';
}

function todayIso(): string {
  const now = new Date();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${now.getFullYear()}-${month}-${day}`;
}

function periodsOverlap(
  leftStart: string,
  leftEnd: string,
  rightStart: string,
  rightEnd: string | null,
): boolean {
  const normalizedLeftEnd = leftEnd || '9999-12-31';
  const normalizedRightEnd = rightEnd || '9999-12-31';
  return leftStart <= normalizedRightEnd && rightStart <= normalizedLeftEnd;
}

type BrowserLocation = {
  pathname: string;
  search: string;
};

function readBrowserLocation(): BrowserLocation {
  if (typeof window === 'undefined') return { pathname: '/recipients', search: '' };
  return {
    pathname: window.location.pathname || '/recipients',
    search: window.location.search,
  };
}

export const RecipientsPage = () => {
  const [location, setLocation] = useState<BrowserLocation>(readBrowserLocation);
  const listScrollRef = useRef<HTMLDivElement | null>(null);
  const listScrollTopRef = useRef(0);
  const [recipientForm, setRecipientForm] = useState<RecipientFormState>(emptyRecipientForm);
  const [createOpen, setCreateOpen] = useState(false);
  const [createSaving, setCreateSaving] = useState(false);
  const [createMessage, setCreateMessage] = useState<string | null>(null);
  const [createError, setCreateError] = useState<string | null>(null);
  const [listData, setListData] = useState<{
    items: Recipient[];
    total: number;
    page: number;
    page_size: number;
  } | null>(null);
  const [listLoading, setListLoading] = useState(true);
  const [listError, setListError] = useState<string | null>(null);
  const [listReload, setListReload] = useState(0);
  const [workspaceReload, setWorkspaceReload] = useState(0);
  const [detailRecipient, setDetailRecipient] = useState<Recipient | null>(null);
  const [detailForm, setDetailForm] = useState<RecipientFormState>(emptyRecipientForm);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [detailSaving, setDetailSaving] = useState(false);
  const [detailMessage, setDetailMessage] = useState<string | null>(null);
  const [detailStaleConflict, setDetailStaleConflict] = useState<RecipientStaleConflict | null>(null);
  const [guardians, setGuardians] = useState<Guardian[]>([]);
  const [guardianForm, setGuardianForm] = useState<GuardianFormState>(emptyGuardianForm);
  const [editingGuardianId, setEditingGuardianId] = useState<string | null>(null);
  const [guardianSaving, setGuardianSaving] = useState(false);
  const [guardianMessage, setGuardianMessage] = useState<string | null>(null);
  const [guardianError, setGuardianError] = useState<string | null>(null);
  const [primaryPeriods, setPrimaryPeriods] = useState<PrimaryGuardianPeriod[]>([]);
  const [primaryForm, setPrimaryForm] = useState<PrimaryPeriodFormState>(emptyPrimaryPeriodForm);
  const [editingPrimaryPeriodId, setEditingPrimaryPeriodId] = useState<string | null>(null);
  const [primarySaving, setPrimarySaving] = useState(false);
  const [primaryMessage, setPrimaryMessage] = useState<string | null>(null);
  const [primaryPeriodsError, setPrimaryPeriodsError] = useState<string | null>(null);
  const [payerSnapshots, setPayerSnapshots] = useState<PayerSnapshot[]>([]);
  const [payerForm, setPayerForm] = useState<PayerFormState>(emptyPayerForm);
  const [editingPayerSnapshotId, setEditingPayerSnapshotId] = useState<string | null>(null);
  const [payerSaving, setPayerSaving] = useState(false);
  const [payerMessage, setPayerMessage] = useState<string | null>(null);
  const [payerError, setPayerError] = useState<string | null>(null);
  const [planNotifications, setPlanNotifications] = useState<PlanNotification[]>([]);
  const [planNotificationDate, setPlanNotificationDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [planNotificationSaving, setPlanNotificationSaving] = useState(false);
  const [planNotificationMessage, setPlanNotificationMessage] = useState<string | null>(null);
  const [planNotificationError, setPlanNotificationError] = useState<string | null>(null);

  useEffect(() => {
    const handlePopState = () => setLocation(readBrowserLocation());
    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, []);

  const query = useMemo(() => new URLSearchParams(location.search), [location.search]);
  const search = query.get('search') ?? '';
  const filter = query.get('filter') ?? 'ALL';
  const sort = query.get('sort') ?? 'name_asc';
  const page = parsePage(query.get('page'));
  const selectedId = query.get('selected');
  const detailId = query.get('detail');
  const activeId = detailId ?? selectedId;

  const updateQuery = useCallback(
    (updates: Record<string, string | null>, replace = true) => {
      const currentLocation = readBrowserLocation();
      const nextQuery = new URLSearchParams(currentLocation.search);
      Object.entries(updates).forEach(([key, value]) => {
        if (value === null || value === '') {
          nextQuery.delete(key);
        } else {
          nextQuery.set(key, value);
        }
      });
      const nextSearch = nextQuery.toString();
      const nextUrl = `${currentLocation.pathname}${nextSearch ? `?${nextSearch}` : ''}`;
      if (replace) {
        window.history.replaceState(window.history.state, '', nextUrl);
      } else {
        window.history.pushState(window.history.state, '', nextUrl);
      }
      window.dispatchEvent(new PopStateEvent('popstate'));
    },
    [],
  );

  const selectedRecipient = useMemo(
    () =>
      (selectedId
        ? listData?.items.find((item) => normalizeId(item.id) === selectedId) ?? null
        : listData?.items[0] ?? null),
    [listData, selectedId],
  );

  const visibleRecipients = useMemo(() => {
    const items = [...(listData?.items ?? [])];
    items.sort((left, right) => {
      const nameComparison = left.name.localeCompare(right.name, 'ko');
      const comparison =
        nameComparison ||
        String(left.id).localeCompare(String(right.id), 'en', { numeric: true });
      return sort === 'name_desc' ? comparison * -1 : comparison;
    });
    return items;
  }, [listData, sort]);

  useEffect(() => {
    const controller = new AbortController();
    let cancelled = false;
    setListLoading(true);
    setListError(null);

    listRecipients({ search, page, pageSize: PAGE_SIZE, signal: controller.signal })
      .then((response) => {
        if (cancelled) return;
        setListData(response);
        setListLoading(false);
      })
      .catch((error: unknown) => {
        if (cancelled || isAbortError(error)) return;
        setListLoading(false);
        setListError(safeErrorMessage(error, '수급자 목록을 불러오지 못했습니다.'));
      });

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [listReload, page, search]);

  useEffect(() => {
    if (selectedId || !listData?.items.length) return;
    updateQuery({ selected: normalizeId(listData.items[0].id) }, true);
  }, [listData, selectedId, updateQuery]);

  useEffect(() => {
    const listNode = listScrollRef.current;
    if (listNode) listNode.scrollTop = listScrollTopRef.current;
  }, [detailId, location.search, visibleRecipients.length]);

  useEffect(() => {
    setPrimaryForm(emptyPrimaryPeriodForm());
    setEditingPrimaryPeriodId(null);
    setPayerForm(emptyPayerForm());
    setEditingPayerSnapshotId(null);
    setPrimaryMessage(null);
    setPayerMessage(null);
    setDetailStaleConflict(null);
  }, [activeId]);

  useEffect(() => {
    const controller = new AbortController();
    let cancelled = false;
    if (!activeId) {
      setDetailRecipient(null);
      setDetailForm(emptyRecipientForm());
      setGuardians([]);
      setGuardianForm(emptyGuardianForm());
      setEditingGuardianId(null);
      setPrimaryPeriods([]);
      setPrimaryForm(emptyPrimaryPeriodForm());
      setEditingPrimaryPeriodId(null);
      setPayerSnapshots([]);
      setPayerForm(emptyPayerForm());
      setEditingPayerSnapshotId(null);
      setDetailLoading(false);
      setDetailError(null);
      setDetailStaleConflict(null);
      return () => {
        cancelled = true;
        controller.abort();
      };
    }

    if (
      detailStaleConflict &&
      normalizeId(detailStaleConflict.latest.id) === activeId
    ) {
      setDetailLoading(false);
      return () => {
        cancelled = true;
        controller.abort();
      };
    }

    setDetailLoading(true);
    setDetailError(null);
    setGuardianError(null);
    setPrimaryPeriodsError(null);
    setPayerError(null);

    const inlineFallback = listData?.items.find((item) => normalizeId(item.id) === activeId) ?? null;
    if (inlineFallback) {
      const embeddedFallback = inlineFallback as EmbeddedRecipient;
      const inlineGuardians = embeddedFallback.guardians ?? [];
      setDetailRecipient(inlineFallback);
      setDetailForm({
        name: inlineFallback.name,
        birth_date: inlineFallback.birth_date,
        sex_code: inlineFallback.sex_code,
        postal_code: inlineFallback.postal_code ?? '',
        address: inlineFallback.address ?? '',
        home_phone: inlineFallback.home_phone ?? '',
        mobile_phone: inlineFallback.mobile_phone ?? '',
        memo: inlineFallback.memo ?? '',
      });
      setGuardians(inlineGuardians);
      const firstInlineGuardian = inlineGuardians[0];
      setGuardianForm(firstInlineGuardian ? guardianFormFromGuardian(firstInlineGuardian) : emptyGuardianForm());
      setEditingGuardianId(firstInlineGuardian ? normalizeId(firstInlineGuardian.id) : null);
    }

    Promise.allSettled([
      getRecipient(activeId, controller.signal),
      listGuardians(activeId, controller.signal),
      listPrimaryGuardianPeriods(activeId, controller.signal),
      listPayerSnapshots(activeId, controller.signal),
    ]).then(([recipientResult, guardianResult, periodResult, payerResult]) => {
      if (cancelled) return;

      const listFallback =
        listData?.items.find((item) => normalizeId(item.id) === activeId) ?? null;
      const recipient = valueFromResult(recipientResult) ?? listFallback;
      const embedded = recipient as EmbeddedRecipient | null;
      const embeddedGuardians = embedded?.guardians ?? [];
      const guardianResponse = valueFromResult(guardianResult);
      const periodResponse = valueFromResult(periodResult);
      const payerResponse = valueFromResult(payerResult);
      const resolvedGuardians = guardianResponse?.items ?? embeddedGuardians;

      if (recipient) {
        setDetailRecipient(recipient);
        setDetailForm(recipientFormFromRecipient(recipient));
        setDetailStaleConflict(null);
      } else if (recipientResult.status === 'rejected') {
        setDetailRecipient(null);
        setDetailError(safeErrorMessage(recipientResult.reason, '수급자 상세를 불러오지 못했습니다.'));
      }

      setGuardians(resolvedGuardians);
      const firstGuardian = resolvedGuardians[0];
      setGuardianForm(firstGuardian ? guardianFormFromGuardian(firstGuardian) : emptyGuardianForm());
      setEditingGuardianId(firstGuardian ? normalizeId(firstGuardian.id) : null);
      setPrimaryPeriods(periodResponse?.items ?? []);
      setPayerSnapshots(payerResponse?.items ?? []);

      if (guardianResult.status === 'rejected' && !embeddedGuardians.length) {
        setGuardianError('보호자 정보를 불러오지 못했습니다.');
      }
      if (periodResult.status === 'rejected') {
        setPrimaryPeriodsError('대표 보호자 이력을 불러오지 못했습니다.');
      }
      if (payerResult.status === 'rejected') {
        setPayerError('납부자 이력을 불러오지 못했습니다.');
      }
      setDetailLoading(false);
    });

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [activeId, detailStaleConflict, listData, workspaceReload]);

  useEffect(() => {
    const controller = new AbortController();
    let cancelled = false;
    if (!activeId) {
      setPlanNotifications([]);
      return () => {
        cancelled = true;
        controller.abort();
      };
    }

    setPlanNotificationDate(new Date().toISOString().slice(0, 10));
    setPlanNotificationMessage(null);
    setPlanNotificationError(null);

    listPlanNotifications(activeId, controller.signal)
      .then((response) => {
        if (cancelled) return;
        setPlanNotifications(response.items ?? []);
      })
      .catch((error: unknown) => {
        if (cancelled || isAbortError(error) || controller.signal.aborted) return;
        setPlanNotificationError(
          safeErrorMessage(error, '계획서 통보일 이력을 불러오지 못했습니다.'),
        );
      });

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [activeId, workspaceReload]);

  const handlePlanNotificationSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!activeId || !planNotificationDate) {
      setPlanNotificationError('계획서 통보일을 입력해주세요.');
      return;
    }

    setPlanNotificationSaving(true);
    setPlanNotificationMessage(null);
    setPlanNotificationError(null);
    try {
      const payload: PlanNotificationCreateRequest = {
        notified_date: planNotificationDate,
      };
      await createPlanNotification(activeId, payload);
      const response = await listPlanNotifications(activeId);
      setPlanNotifications(response.items ?? []);
      setPlanNotificationDate(new Date().toISOString().slice(0, 10));
      setPlanNotificationMessage('계획서 통보일을 저장했습니다.');
    } catch (error: unknown) {
      if (!isAbortError(error)) {
        setPlanNotificationError(safeErrorMessage(error, '계획서 통보일을 저장하지 못했습니다.'));
      }
    } finally {
      setPlanNotificationSaving(false);
    }
  };

  const handlePlanNotificationInvalidate = async (row: PlanNotification) => {
    if (!activeId) return;

    setPlanNotificationSaving(true);
    setPlanNotificationMessage(null);
    setPlanNotificationError(null);
    try {
      await invalidatePlanNotification(activeId, row.id, {
        expected_row_version: row.row_version,
      });
      const response = await listPlanNotifications(activeId);
      setPlanNotifications(response.items ?? []);
      setPlanNotificationMessage('계획서 통보일을 무효화했습니다.');
    } catch (error: unknown) {
      if (!isAbortError(error)) {
        setPlanNotificationError(safeErrorMessage(error, '계획서 통보일을 무효화하지 못했습니다.'));
      }
    } finally {
      setPlanNotificationSaving(false);
    }
  };

  const handleCreateSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setCreateMessage(null);
    setCreateError(null);
    if (!recipientForm.name.trim() || !recipientForm.birth_date || !recipientForm.sex_code) {
      setCreateError('이름, 생년월일, 성별을 입력해주세요.');
      return;
    }

    setCreateSaving(true);
    try {
      const created = await createRecipient(recipientCreatePayload(recipientForm));
      const createdEmbedded = created as EmbeddedRecipient;
      setCreateMessage('수급자를 저장했습니다.');
      setRecipientForm(emptyRecipientForm());
      setDetailRecipient(created);
      setDetailForm({
        name: created.name,
        birth_date: created.birth_date,
        sex_code: created.sex_code,
        postal_code: created.postal_code ?? '',
        address: created.address ?? '',
        home_phone: created.home_phone ?? '',
        mobile_phone: created.mobile_phone ?? '',
        memo: created.memo ?? '',
      });
      const createdGuardians = createdEmbedded.guardians ?? [];
      setGuardians(createdGuardians);
      const firstGuardian = createdGuardians[0];
      setGuardianForm(firstGuardian ? guardianFormFromGuardian(firstGuardian) : emptyGuardianForm());
      setEditingGuardianId(firstGuardian ? normalizeId(firstGuardian.id) : null);
      updateQuery(
        {
          selected: normalizeId(created.id),
          detail: normalizeId(created.id),
        },
        false,
      );
      setListReload((current) => current + 1);
    } catch (error: unknown) {
      if (!isAbortError(error)) {
        setCreateError(safeErrorMessage(error, '수급자를 저장하지 못했습니다.'));
      }
    } finally {
      setCreateSaving(false);
    }
  };

  const captureRecipientStaleConflict = async (original: Recipient): Promise<void> => {
    try {
      const latest = await getRecipient(activeId ?? '');
      if (normalizeId(latest.id) !== activeId) {
        setDetailError('저장 충돌 후 대상 수급자의 최신 정보를 확인하지 못했습니다. 입력은 유지됩니다.');
        return;
      }
      setDetailStaleConflict({ original, latest });
      setDetailError('다른 사용자가 먼저 변경했습니다. 최신 서버값을 확인하고 필요한 변경만 다시 적용해주세요.');
    } catch (error: unknown) {
      if (!isAbortError(error)) {
        setDetailError(
          safeErrorMessage(
            error,
            '저장 충돌 후 최신 수급자 정보를 불러오지 못했습니다. 입력은 유지됩니다.',
          ),
        );
      }
    }
  };

  const handleDetailSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!detailRecipient || !activeId) return;
    setDetailMessage(null);
    setDetailError(null);
    setDetailSaving(true);
    try {
      const updated = await updateRecipient(
        activeId,
        recipientUpdatePayload(detailForm, detailRecipient.row_version),
      );
      setDetailRecipient(updated);
      setDetailForm(recipientFormFromRecipient(updated));
      setDetailStaleConflict(null);
      setListData((current) =>
        current
          ? { ...current, items: current.items.map((item) => (normalizeId(item.id) === activeId ? updated : item)) }
          : current,
      );
      setDetailMessage('수급자 정보를 저장했습니다.');
      setListReload((current) => current + 1);
    } catch (error: unknown) {
      if (!isAbortError(error)) {
        if (isApiErrorCode(error, 'ROW_VERSION_CONFLICT')) {
          await captureRecipientStaleConflict(detailRecipient);
        } else {
          setDetailError(safeErrorMessage(error, '수급자 정보를 저장하지 못했습니다.'));
        }
      }
    } finally {
      setDetailSaving(false);
    }
  };

  const handleDetailReapply = async () => {
    if (!detailStaleConflict || !activeId) return;
    if (!detailForm.name.trim() || !detailForm.birth_date || !detailForm.sex_code) {
      setDetailError('이름, 생년월일, 성별을 입력해주세요.');
      return;
    }
    setDetailError(null);
    setDetailMessage(null);
    setDetailSaving(true);
    try {
      const updated = await updateRecipient(
        activeId,
        recipientReapplyPayload(
          detailStaleConflict.original,
          detailForm,
          detailStaleConflict.latest.row_version,
        ),
      );
      setDetailRecipient(updated);
      setDetailForm(recipientFormFromRecipient(updated));
      setDetailStaleConflict(null);
      setDetailError(null);
      setDetailMessage('최신 버전에 변경 내용을 다시 적용했습니다.');
      setListData((current) =>
        current
          ? { ...current, items: current.items.map((item) => (normalizeId(item.id) === activeId ? updated : item)) }
          : current,
      );
      setListReload((current) => current + 1);
    } catch (error: unknown) {
      if (!isAbortError(error)) {
        if (isApiErrorCode(error, 'ROW_VERSION_CONFLICT')) {
          await captureRecipientStaleConflict(detailStaleConflict.original);
        } else {
          setDetailError(safeErrorMessage(error, '변경 내용을 다시 적용하지 못했습니다.'));
        }
      }
    } finally {
      setDetailSaving(false);
    }
  };

  const handleGuardianSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!activeId || !guardianForm.name.trim()) {
      setGuardianError('보호자 이름을 입력해주세요.');
      return;
    }
    setGuardianError(null);
    setGuardianMessage(null);
    setGuardianSaving(true);
    try {
      const existing = guardians.find((guardian) => normalizeId(guardian.id) === editingGuardianId);
      const payload = guardianPayload(guardianForm);
      const saved = existing
        ? await updateGuardian(activeId, existing.id, {
            ...payload,
            expected_row_version: existing.row_version,
          })
        : await createGuardian(activeId, payload);
      setGuardians((current) =>
        existing
          ? current.map((guardian) => (normalizeId(guardian.id) === editingGuardianId ? saved : guardian))
          : [...current, saved],
      );
      setEditingGuardianId(normalizeId(saved.id));
      setGuardianForm(guardianFormFromGuardian(saved));
      setGuardianMessage('보호자 정보를 저장했습니다.');
    } catch (error: unknown) {
      if (!isAbortError(error)) {
        setGuardianError(safeErrorMessage(error, '보호자 정보를 저장하지 못했습니다.'));
      }
    } finally {
      setGuardianSaving(false);
    }
  };

  const handlePrimarySubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!activeId) {
      setPrimaryPeriodsError('수급자를 먼저 선택해주세요.');
      return;
    }
    setPrimaryPeriodsError(null);
    setPrimaryMessage(null);

    const guardianId = Number.parseInt(primaryForm.guardian_id, 10);
    if (!Number.isSafeInteger(guardianId) || guardianId <= 0 || !primaryForm.start_date) {
      setPrimaryPeriodsError('대표 보호자와 시작일을 입력해주세요.');
      return;
    }
    if (primaryForm.end_date && primaryForm.end_date < primaryForm.start_date) {
      setPrimaryPeriodsError('종료일은 시작일보다 빠를 수 없습니다. 비워두면 종료되지 않은 기간입니다.');
      return;
    }

    const existing = primaryPeriods.find(
      (period) => normalizeId(period.id) === editingPrimaryPeriodId,
    );
    const overlapsExistingPeriod = primaryPeriods.some(
      (period) =>
        normalizeId(period.id) !== editingPrimaryPeriodId &&
        !period.invalidated_at_utc &&
        periodsOverlap(
          primaryForm.start_date,
          primaryForm.end_date,
          period.start_date,
          period.end_date,
        ),
    );
    if (overlapsExistingPeriod) {
      setPrimaryPeriodsError(
        '선택한 기간에 이미 유효한 대표 보호자 기간이 있습니다. 기존 기간을 교체하거나 날짜를 조정해주세요.',
      );
      return;
    }

    setPrimarySaving(true);
    try {
      const payload = primaryPeriodPayload(primaryForm);
      if (existing) {
        const replacementPayload: PrimaryGuardianPeriodReplacementRequest = {
          ...payload,
          expected_row_version: existing.row_version,
        };
        await replacePrimaryGuardianPeriod(activeId, existing.id, replacementPayload);
        setPrimaryMessage('대표 보호자 기간을 교체했습니다.');
      } else {
        await createPrimaryGuardianPeriod(activeId, payload);
        setPrimaryMessage('대표 보호자 기간을 지정했습니다.');
      }
      setPrimaryForm(emptyPrimaryPeriodForm());
      setEditingPrimaryPeriodId(null);
      setWorkspaceReload((current) => current + 1);
    } catch (error: unknown) {
      if (!isAbortError(error)) {
        setPrimaryPeriodsError(
          safeErrorMessage(error, '대표 보호자 기간을 저장하지 못했습니다.'),
        );
      }
    } finally {
      setPrimarySaving(false);
    }
  };

  const handlePrimaryInvalidate = async (period: PrimaryGuardianPeriod) => {
    if (!activeId) return;
    setPrimaryPeriodsError(null);
    setPrimaryMessage(null);
    setPrimarySaving(true);
    try {
      await invalidatePrimaryGuardianPeriod(activeId, period.id, {
        expected_row_version: period.row_version,
      });
      if (editingPrimaryPeriodId === normalizeId(period.id)) {
        setPrimaryForm(emptyPrimaryPeriodForm());
        setEditingPrimaryPeriodId(null);
      }
      setPrimaryMessage('대표 보호자 기간을 무효화했습니다.');
      setWorkspaceReload((current) => current + 1);
    } catch (error: unknown) {
      if (!isAbortError(error)) {
        setPrimaryPeriodsError(
          safeErrorMessage(error, '대표 보호자 기간을 무효화하지 못했습니다.'),
        );
      }
    } finally {
      setPrimarySaving(false);
    }
  };

  const handlePayerSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!activeId || !payerForm.name.trim() || !payerForm.start_date) {
      setPayerError('납부자 이름을 입력해주세요.');
      return;
    }
    if (payerForm.end_date && payerForm.end_date < payerForm.start_date) {
      setPayerError('종료일은 시작일보다 빠를 수 없습니다. 비워두면 종료되지 않은 기간입니다.');
      return;
    }
    setPayerError(null);
    setPayerMessage(null);

    const existing = payerSnapshots.find(
      (snapshot) => normalizeId(snapshot.id) === editingPayerSnapshotId,
    );
    const overlapsExistingSnapshot = payerSnapshots.some(
      (snapshot) =>
        normalizeId(snapshot.id) !== editingPayerSnapshotId &&
        !snapshot.invalidated_at_utc &&
        periodsOverlap(
          payerForm.start_date,
          payerForm.end_date,
          snapshot.start_date,
          snapshot.end_date,
        ),
    );
    if (overlapsExistingSnapshot) {
      setPayerError('선택한 기간에 이미 유효한 납부자 snapshot이 있습니다. 기간을 조정해주세요.');
      return;
    }

    setPayerSaving(true);
    try {
      const payload = payerPayload(payerForm);
      if (existing) {
        const replacementPayload: PayerSnapshotReplacementRequest = {
          ...payload,
          expected_row_version: existing.row_version,
        };
        await replacePayerSnapshot(activeId, existing.id, replacementPayload);
        setPayerMessage('납부자 snapshot을 교체했습니다.');
      } else {
        await createPayerSnapshot(activeId, payload);
        setPayerMessage('납부자 snapshot을 지정했습니다.');
      }
      setPayerForm(emptyPayerForm());
      setEditingPayerSnapshotId(null);
      setWorkspaceReload((current) => current + 1);
    } catch (error: unknown) {
      if (!isAbortError(error)) {
        setPayerError(safeErrorMessage(error, '납부자 snapshot을 저장하지 못했습니다.'));
      }
    } finally {
      setPayerSaving(false);
    }
  };

  const handlePayerInvalidate = async (snapshot: PayerSnapshot) => {
    if (!activeId) return;
    setPayerError(null);
    setPayerMessage(null);
    setPayerSaving(true);
    try {
      await invalidatePayerSnapshot(activeId, snapshot.id, {
        expected_row_version: snapshot.row_version,
      });
      if (editingPayerSnapshotId === normalizeId(snapshot.id)) {
        setPayerForm(emptyPayerForm());
        setEditingPayerSnapshotId(null);
      }
      setPayerMessage('납부자 snapshot을 무효화했습니다.');
      setWorkspaceReload((current) => current + 1);
    } catch (error: unknown) {
      if (!isAbortError(error)) {
        setPayerError(safeErrorMessage(error, '납부자 snapshot을 무효화하지 못했습니다.'));
      }
    } finally {
      setPayerSaving(false);
    }
  };

  const startPrimaryReplacement = (period: PrimaryGuardianPeriod) => {
    setPrimaryPeriodsError(null);
    setPrimaryMessage(null);
    setEditingPrimaryPeriodId(normalizeId(period.id));
    setPrimaryForm({
      guardian_id: String(period.guardian_id),
      start_date: period.start_date,
      end_date: period.end_date ?? '',
    });
  };

  const startPayerReplacement = (snapshot: PayerSnapshot) => {
    setPayerError(null);
    setPayerMessage(null);
    setEditingPayerSnapshotId(normalizeId(snapshot.id));
    setPayerForm({
      name: snapshot.name,
      phone: snapshot.phone ?? '',
      address: snapshot.address ?? '',
      relationship_text: snapshot.relationship_text ?? '',
      start_date: snapshot.start_date,
      end_date: snapshot.end_date ?? '',
    });
  };

  const openDetail = (recipientId: number | string) => {
    const nextSelected = normalizeId(recipientId);
    updateQuery(
      {
        selected: nextSelected,
        detail: normalizeId(recipientId),
      },
      false,
    );
  };

  const closeDetail = () => updateQuery({ detail: null, selected: null }, false);

  const handleListScroll = (scrollTop: number) => {
    listScrollTopRef.current = scrollTop;
  };

  const activeListRecipient = useMemo(
    () =>
      listData?.items.find((item) => normalizeId(item.id) === activeId) ??
      null,
    [activeId, listData],
  );
  const detailViewRecipient =
    detailRecipient && normalizeId(detailRecipient.id) === activeId
      ? detailRecipient
      : activeListRecipient ?? (detailId ? null : selectedRecipient);
  const guardianNames = useMemo(
    () => new Map(guardians.map((guardian) => [normalizeId(guardian.id), guardian.name])),
    [guardians],
  );
  return (
    <div className="recipients-page" data-testid="page-recipients">
      <div className="recipient-page-heading">
        <div>
          <h1>수급자 관리</h1>
        </div>
        <div className="recipient-page-status" aria-live="polite">
          {listLoading ? (
            <span className="recipient-status recipient-status-loading">목록 불러오는 중</span>
          ) : listError ? (
            <span className="recipient-status recipient-status-error">목록 확인 필요</span>
          ) : null}
        </div>
      </div>

      <div className="recipient-workspace-grid">
        <section className="recipient-list-panel" data-testid="recipient-list">
          <h2 className="visually-hidden">수급자 목록</h2>

          <div className="recipient-list-controls">
            <label className="recipient-field recipient-search-field">
              <span className="visually-hidden">검색</span>
              <input
                data-testid="recipient-search-input"
                value={search}
                onChange={(event) => updateQuery({ search: event.target.value, page: '1' }, true)}
                placeholder="이름 검색"
              />
            </label>
            <button
              className="recipient-secondary-button"
              type="button"
              data-testid="recipient-create-toggle"
              aria-expanded={createOpen}
              onClick={() => setCreateOpen((current) => !current)}
            >
              {createOpen ? '등록 닫기' : '수급자 등록'}
            </button>
            <label className="recipient-field recipient-filter-field">
              <span className="visually-hidden">상태</span>
              <select
                data-testid="recipient-filter-select"
                value={filter}
                onChange={(event) => updateQuery({ filter: event.target.value, page: '1' }, true)}
              >
                <option value="ACTIVE">이용중</option>
                <option value="ALL">전체</option>
                <option value="HISTORY">계약종료</option>
                <option value="WAITING">대기중</option>
              </select>
            </label>
            <span className="recipient-count" data-testid="recipient-count" aria-live="polite">
              총 {listData?.total ?? 0}명
            </span>
          </div>

          <div className="recipient-list-header" data-testid="recipient-list-header">
            <span>이름</span>
            <span>만 나이</span>
            <span>등급</span>
            <span>제공중 서비스</span>
          </div>

          <span className="visually-hidden" data-testid="recipient-selected-name">
            {selectedRecipient?.name ?? (selectedId ? '현재 페이지에 없음' : '없음')}
          </span>

          <div
            ref={listScrollRef}
            className="recipient-list-scroll"
            data-testid="recipient-list-scroll"
            onScroll={(event) => handleListScroll(event.currentTarget.scrollTop)}
          >
            {listLoading && !visibleRecipients.length ? (
              <div className="recipient-list-row recipient-list-row-placeholder">
                <span data-testid="recipient-list-loading">목록을 불러오는 중입니다.</span>
              </div>
            ) : null}
            {listError ? <div className="recipient-inline-error">{listError}</div> : null}
            {!listLoading && !listError && !visibleRecipients.length ? (
              <div className="recipient-empty-state">등록된 수급자가 없습니다.</div>
            ) : null}
            {visibleRecipients.map((recipient, index) => {
              const id = normalizeId(recipient.id);
              const isSelected = id === selectedId;
              const listIndex = (page - 1) * (listData?.page_size ?? PAGE_SIZE) + index + 1;
              return (
                <button
                  className={`recipient-list-row${isSelected ? ' is-selected' : ''}`}
                  data-testid="recipient-name-option"
                  key={id}
                  type="button"
                  onClick={() => openDetail(recipient.id)}
                >
                  <span className="recipient-list-row-main">
                    <span className="recipient-list-index" aria-hidden="true">{listIndex}</span>
                    <strong>{recipient.name}</strong>
                    <span className="visually-hidden">
                      {recipient.birth_date} · {recipient.sex_code}
                    </span>
                    <span className="visually-hidden">주소: <span data-testid="recipient-list-address">{formatNullable(recipient.address)}</span></span>
                    <span className="visually-hidden">자택: <span data-testid="recipient-list-home-phone">{formatNullable(recipient.home_phone)}</span></span>
                    <span className="visually-hidden">휴대전화: <span data-testid="recipient-list-mobile-phone">{formatNullable(recipient.mobile_phone)}</span></span>
                  </span>
                  <span className="recipient-list-cell recipient-list-age">{formatFullAge(recipient.birth_date)}</span>
                  <span className="recipient-list-cell recipient-list-grade">미지정</span>
                  <span className="recipient-list-cell recipient-list-services">미지정</span>
                  <span className="visually-hidden recipient-list-row-meta">
                    <span data-testid="recipient-list-recipient-no">
                      {formatRecipientNo(recipient.recipient_no)}
                    </span>
                  </span>
                </button>
              );
            })}
          </div>

          <div className="recipient-list-footer">
            <button
              type="button"
              disabled={page <= 1}
              onClick={() => updateQuery({ page: String(Math.max(1, page - 1)) }, true)}
            >
              이전
            </button>
            <span data-testid="recipient-page-indicator">{page}</span>
            <button
              type="button"
              disabled={page * (listData?.page_size ?? PAGE_SIZE) >= (listData?.total ?? 0)}
              onClick={() => updateQuery({ page: String(page + 1) }, true)}
            >
              다음
            </button>
          </div>

          {false && (
          <form
            className={`recipient-create-form${createOpen ? ' is-open' : ''}`}
            data-testid="recipient-create-form"
            onSubmit={handleCreateSubmit}
          >
            <div className="recipient-form-heading">
              <div>
                <h3>수급자 등록</h3>
              </div>
            </div>
            <div className="recipient-form-grid">
              <label className="recipient-field">
                이름 <em>필수</em>
                <input
                  data-testid="recipient-name-input"
                  value={recipientForm.name}
                  onChange={(event) => setRecipientForm((current) => ({ ...current, name: event.target.value }))}
                  required
                />
              </label>
              <label className="recipient-field">
                생년월일 <em>필수</em>
                <input
                  data-testid="recipient-birth-date-input"
                  type="date"
                  value={recipientForm.birth_date}
                  onChange={(event) => setRecipientForm((current) => ({ ...current, birth_date: event.target.value }))}
                  required
                />
              </label>
              <label className="recipient-field">
                성별 <em>필수</em>
                <select
                  data-testid="recipient-sex-code-select"
                  value={recipientForm.sex_code}
                  onChange={(event) =>
                    setRecipientForm((current) => ({
                      ...current,
                      sex_code: event.target.value as RecipientSexCode,
                    }))
                  }
                  required
                >
                  <option value="MALE">남성</option>
                  <option value="FEMALE">여성</option>
                </select>
              </label>
              <label className="recipient-field">
                우편번호
                <input
                  data-testid="recipient-postal-code-input"
                  value={recipientForm.postal_code}
                  onChange={(event) => setRecipientForm((current) => ({ ...current, postal_code: event.target.value }))}
                />
              </label>
              <label className="recipient-field recipient-field-wide">
                주소
                <input
                  data-testid="recipient-address-input"
                  value={recipientForm.address}
                  onChange={(event) => setRecipientForm((current) => ({ ...current, address: event.target.value }))}
                />
              </label>
              <label className="recipient-field">
                자택 전화
                <input
                  data-testid="recipient-home-phone-input"
                  value={recipientForm.home_phone}
                  onChange={(event) => setRecipientForm((current) => ({ ...current, home_phone: event.target.value }))}
                />
              </label>
              <label className="recipient-field">
                휴대전화
                <input
                  data-testid="recipient-mobile-phone-input"
                  value={recipientForm.mobile_phone}
                  onChange={(event) => setRecipientForm((current) => ({ ...current, mobile_phone: event.target.value }))}
                />
              </label>
              <label className="recipient-field recipient-field-wide">
                출처 메모
                <textarea
                  data-testid="recipient-memo-input"
                  value={recipientForm.memo}
                  onChange={(event) => setRecipientForm((current) => ({ ...current, memo: event.target.value }))}
                />
              </label>
            </div>
            {createError ? <div className="recipient-inline-error">{createError}</div> : null}
            {createMessage ? <div className="recipient-inline-note">{createMessage}</div> : null}
            <div className="recipient-form-actions">
              <button className="recipient-primary-button" data-testid="recipient-submit-button" type="submit" disabled={createSaving}>
                {createSaving ? '저장 중…' : '수급자 저장'}
              </button>
            </div>
          </form>
          )}
        </section>

        <section
          className={`recipient-detail-panel${activeId ? '' : ' is-idle'}`}
          data-testid="recipient-detail-workspace"
        >
          <div className="recipient-detail-heading">
            <div className="recipient-detail-title">
              <h2>{detailViewRecipient?.name ?? '수급자 상세'}</h2>
              <span className="recipient-detail-recipient-no">
                <span>수급자번호</span>
                <strong data-testid="recipient-detail-recipient-no">
                  {formatRecipientNo(detailViewRecipient?.recipient_no)}
                </strong>
              </span>
            </div>
            <button className="recipient-secondary-button" type="button" onClick={closeDetail}>
              목록 유지
            </button>
          </div>

          {!activeId ? (
            <div className="recipient-idle-message">목록에서 수급자를 선택하세요.</div>
          ) : null}

          {detailLoading ? <div className="recipient-inline-note">상세 정보를 불러오는 중입니다.</div> : null}
          {detailError ? <div className="recipient-inline-error">{detailError}</div> : null}

          <div className="recipient-detail-summary">
            <div className="recipient-summary-item">
              <span>생년월일</span>
              <strong>{detailViewRecipient?.birth_date ?? '없음'}</strong>
            </div>
            <div className="recipient-summary-item">
              <span>등급</span>
              <strong data-testid="recipient-detail-grade">미지정</strong>
            </div>
            <div className="recipient-summary-item">
              <span>인정번호</span>
              <strong>L1234567890</strong>
            </div>
            <div className="recipient-summary-item">
              <span>성별</span>
              <strong>{detailViewRecipient?.sex_code ?? '없음'}</strong>
            </div>
            <div className="recipient-summary-item">
              <span>휴대전화</span>
              <strong data-testid="recipient-detail-mobile-phone">
                {formatNullable(detailViewRecipient?.mobile_phone)}
              </strong>
            </div>
            <div className="recipient-summary-item">
              <span>본인부담금</span>
              <strong data-testid="recipient-detail-copay">미지정</strong>
            </div>
            <div className="recipient-summary-item recipient-summary-item-address">
              <span>주소</span>
              <strong data-testid="recipient-detail-address">
                {formatNullable(detailViewRecipient?.address)}
              </strong>
            </div>
          </div>
          <span className="visually-hidden" data-testid="recipient-detail-home-phone">
            {formatNullable(detailViewRecipient?.home_phone)}
          </span>

          {detailStaleConflict ? (
            <div className="recipient-stale-panel" role="alert">
              <div data-testid="recipient-stale-latest-value">
                최신 서버값: {detailStaleConflict.latest.name}
              </div>
              <div data-testid="recipient-stale-diff">
                사용자 입력: {detailForm.name || '없음'} / 최신 서버값: {detailStaleConflict.latest.name}
              </div>
              <button
                className="recipient-secondary-button"
                data-testid="recipient-stale-reapply"
                type="button"
                onClick={() => void handleDetailReapply()}
                disabled={detailSaving}
              >
                최신 버전에 변경 내용 다시 적용
              </button>
            </div>
          ) : null}

          {detailViewRecipient ? (
            <form className="recipient-detail-form" onSubmit={handleDetailSubmit}>
              <div className="recipient-subsection-heading">
                <h3>기본정보</h3>
                <span>수정 시 최신 행 버전을 사용합니다.</span>
              </div>
              <div className="recipient-form-grid">
                <label className="recipient-field">
                  이름
                  <input
                    data-testid="recipient-detail-name-input"
                    value={detailForm.name}
                    onChange={(event) => setDetailForm((current) => ({ ...current, name: event.target.value }))}
                    required
                  />
                </label>
                <label className="recipient-field">
                  생년월일
                  <input
                    data-testid="recipient-detail-birth-date-input"
                    type="date"
                    value={detailForm.birth_date}
                    onChange={(event) => setDetailForm((current) => ({ ...current, birth_date: event.target.value }))}
                    required
                  />
                </label>
                <label className="recipient-field">
                  성별
                  <select
                    data-testid="recipient-detail-sex-code-select"
                    value={detailForm.sex_code}
                    onChange={(event) =>
                      setDetailForm((current) => ({
                        ...current,
                        sex_code: event.target.value as RecipientSexCode,
                      }))
                    }
                    required
                  >
                    <option value="MALE">남성</option>
                    <option value="FEMALE">여성</option>
                  </select>
                </label>
                <label className="recipient-field">
                  우편번호
                  <input
                    value={detailForm.postal_code}
                    onChange={(event) => setDetailForm((current) => ({ ...current, postal_code: event.target.value }))}
                  />
                </label>
                <label className="recipient-field recipient-field-wide">
                  주소
                  <input
                    value={detailForm.address}
                    onChange={(event) => setDetailForm((current) => ({ ...current, address: event.target.value }))}
                  />
                </label>
                <label className="recipient-field">
                  자택 전화
                  <input
                    value={detailForm.home_phone}
                    onChange={(event) => setDetailForm((current) => ({ ...current, home_phone: event.target.value }))}
                  />
                </label>
                <label className="recipient-field">
                  휴대전화
                  <input
                    value={detailForm.mobile_phone}
                    onChange={(event) => setDetailForm((current) => ({ ...current, mobile_phone: event.target.value }))}
                  />
                </label>
                <label className="recipient-field recipient-field-wide">
                  출처 메모
                  <textarea
                    value={detailForm.memo}
                    onChange={(event) => setDetailForm((current) => ({ ...current, memo: event.target.value }))}
                  />
                </label>
              </div>
              {detailMessage ? <div className="recipient-inline-note">{detailMessage}</div> : null}
              <div className="recipient-form-actions">
                <button className="recipient-primary-button" type="submit" disabled={detailSaving}>
                  {detailSaving ? '저장 중…' : '기본정보 저장'}
                </button>
              </div>
            </form>
          ) : (
            <div className="recipient-empty-state">목록에서 수급자를 선택하면 상세정보가 표시됩니다.</div>
          )}

          <div className="recipient-detail-columns">
            <section className="recipient-subsection recipient-guardian-section" data-testid="recipient-guardian-section">
              <div className="recipient-subsection-heading">
                <h3>보호자</h3>
                <span>0명 이상 · 이름만 필수</span>
              </div>
              <div className="recipient-history-list">
                {guardians.length ? (
                  guardians.map((guardian) => (
                    <button
                      className="recipient-history-card"
                      key={normalizeId(guardian.id)}
                      type="button"
                      onClick={() => {
                        setEditingGuardianId(normalizeId(guardian.id));
                        setGuardianForm(guardianFormFromGuardian(guardian));
                      }}
                    >
                      <strong>{guardian.name}</strong>
                      <span>전화: {formatNullable(guardian.phone)}</span>
                      <span>관계: {formatNullable(guardian.relationship_text)}</span>
                      <span>주소: {formatNullable(guardian.address)}</span>
                    </button>
                  ))
                ) : (
                  <div className="recipient-muted">등록된 보호자가 없습니다.</div>
                )}
              </div>
              <form className="recipient-subform" onSubmit={handleGuardianSubmit}>
                <div className="recipient-subsection-heading">
                  <h3>{editingGuardianId ? '보호자 수정' : '보호자 추가'}</h3>
                  {editingGuardianId ? (
                    <button
                      className="recipient-secondary-button"
                      type="button"
                      onClick={() => {
                        setEditingGuardianId(null);
                        setGuardianForm(emptyGuardianForm());
                      }}
                    >
                      새 보호자
                    </button>
                  ) : null}
                </div>
                <label className="recipient-field">
                  이름 <em>필수</em>
                  <input
                    data-testid="guardian-name-input"
                    value={guardianForm.name}
                    onChange={(event) => setGuardianForm((current) => ({ ...current, name: event.target.value }))}
                    required
                    disabled={!activeId}
                  />
                </label>
                <label className="recipient-field">
                  전화
                  <input
                    data-testid="guardian-phone-input"
                    value={guardianForm.phone}
                    onChange={(event) => setGuardianForm((current) => ({ ...current, phone: event.target.value }))}
                    disabled={!activeId}
                  />
                </label>
                <label className="recipient-field">
                  주소
                  <input
                    data-testid="guardian-address-input"
                    value={guardianForm.address}
                    onChange={(event) => setGuardianForm((current) => ({ ...current, address: event.target.value }))}
                    disabled={!activeId}
                  />
                </label>
                <label className="recipient-field">
                  관계
                  <input
                    data-testid="guardian-relationship-input"
                    value={guardianForm.relationship_text}
                    onChange={(event) =>
                      setGuardianForm((current) => ({ ...current, relationship_text: event.target.value }))
                    }
                    disabled={!activeId}
                  />
                </label>
                {guardianError ? <div className="recipient-inline-error">{guardianError}</div> : null}
                {guardianMessage ? <div className="recipient-inline-note">{guardianMessage}</div> : null}
                <button className="recipient-secondary-button" type="submit" disabled={!activeId || guardianSaving}>
                  {guardianSaving ? '저장 중…' : '보호자 저장'}
                </button>
              </form>
            </section>

            {false && (
            <section className="recipient-subsection" data-testid="recipient-primary-guardian-history">
              <div className="recipient-subsection-heading">
                <h3>대표 보호자 기간 이력</h3>
                <span>유효 기간은 겹치지 않게 관리합니다.</span>
              </div>
              <div className="recipient-history-list">
                {primaryPeriods.length ? (
                  primaryPeriods.map((period) => (
                    <div className="recipient-history-card" key={normalizeId(period.id)}>
                      <strong>{guardianNames.get(normalizeId(period.guardian_id)) ?? '보호자 정보 없음'}</strong>
                      <span>시작: {period.start_date}</span>
                      <span>종료: {period.end_date ?? '현재'}</span>
                      <span>{period.invalidated_at_utc ? '무효화됨' : '유효한 이력'}</span>
                      {!period.invalidated_at_utc ? (
                        <div className="recipient-history-card-actions">
                          <button
                            type="button"
                            data-testid={`recipient-primary-period-${period.id}-replace`}
                            onClick={() => startPrimaryReplacement(period)}
                            disabled={!activeId || primarySaving}
                          >
                            대표 보호자 교체
                          </button>
                          <button
                            type="button"
                            data-testid={`recipient-primary-period-${period.id}-invalidate`}
                            onClick={() => void handlePrimaryInvalidate(period)}
                            disabled={!activeId || primarySaving}
                          >
                            기간 무효화
                          </button>
                        </div>
                      ) : null}
                    </div>
                  ))
                ) : (
                  <div className="recipient-muted">대표 보호자 기간 이력이 없습니다.</div>
                )}
              </div>
              <form
                className="recipient-subform"
                data-testid="recipient-primary-guardian-form"
                onSubmit={handlePrimarySubmit}
              >
                <div className="recipient-subsection-heading">
                  <h3>{editingPrimaryPeriodId ? '대표 보호자 기간 교체' : '대표 보호자 지정'}</h3>
                  {editingPrimaryPeriodId ? (
                    <button
                      className="recipient-secondary-button"
                      type="button"
                      onClick={() => {
                        setEditingPrimaryPeriodId(null);
                        setPrimaryForm(emptyPrimaryPeriodForm());
                      }}
                    >
                      새 기간
                    </button>
                  ) : null}
                </div>
                <div className="recipient-form-grid">
                  <label className="recipient-field">
                    대표 보호자 <em>필수</em>
                    <select
                      data-testid="recipient-primary-guardian-select"
                      value={primaryForm.guardian_id}
                      onChange={(event) =>
                        setPrimaryForm((current) => ({ ...current, guardian_id: event.target.value }))
                      }
                      required
                      disabled={!activeId || !guardians.length || primarySaving}
                    >
                      <option value="">보호자 선택</option>
                      {guardians.map((guardian) => (
                        <option key={normalizeId(guardian.id)} value={guardian.id}>
                          {guardian.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="recipient-field">
                    시작일 <em>필수</em>
                    <input
                      data-testid="recipient-primary-start-date-input"
                      type="date"
                      value={primaryForm.start_date}
                      onChange={(event) =>
                        setPrimaryForm((current) => ({ ...current, start_date: event.target.value }))
                      }
                      required
                      disabled={!activeId || primarySaving}
                    />
                  </label>
                  <label className="recipient-field">
                    종료일
                    <input
                      data-testid="recipient-primary-end-date-input"
                      type="date"
                      value={primaryForm.end_date}
                      onChange={(event) =>
                        setPrimaryForm((current) => ({ ...current, end_date: event.target.value }))
                      }
                      disabled={!activeId || primarySaving}
                    />
                  </label>
                </div>
                {primaryPeriodsError ? <div className="recipient-inline-error">{primaryPeriodsError}</div> : null}
                {primaryMessage ? <div className="recipient-inline-note">{primaryMessage}</div> : null}
                <button
                  className="recipient-secondary-button"
                  type="submit"
                  disabled={!activeId || !guardians.length || primarySaving}
                >
                  {primarySaving
                    ? '저장 중…'
                    : editingPrimaryPeriodId
                      ? '대표 보호자 기간 교체'
                      : '대표 보호자 기간 지정'}
                </button>
              </form>
            </section>
            )}
          </div>

          {false && (
          <section className="recipient-subsection recipient-payer-section" data-testid="recipient-payer-snapshot-section">
            <div className="recipient-subsection-heading">
              <h3>납부자 snapshot</h3>
              <span>보호자와 독립된 기간 이력</span>
            </div>
            <div className="recipient-history-list">
              {payerSnapshots.length ? (
                payerSnapshots.map((snapshot) => (
                  <div className="recipient-history-card" key={normalizeId(snapshot.id)}>
                    <strong>{snapshot.name}</strong>
                    <span>전화: {formatNullable(snapshot.phone)}</span>
                    <span>주소: {formatNullable(snapshot.address)}</span>
                    <span>관계: {formatNullable(snapshot.relationship_text)}</span>
                    <span>시작: {snapshot.start_date}</span>
                    <span>종료: {snapshot.end_date ?? '현재'}</span>
                    <span>{snapshot.invalidated_at_utc ? '무효화됨' : '유효한 이력'}</span>
                    {!snapshot.invalidated_at_utc ? (
                      <div className="recipient-history-card-actions">
                        <button
                          type="button"
                          data-testid={`recipient-payer-${snapshot.id}-replace`}
                          onClick={() => startPayerReplacement(snapshot)}
                          disabled={!activeId || payerSaving}
                        >
                          납부자 교체
                        </button>
                        <button
                          type="button"
                          data-testid={`recipient-payer-${snapshot.id}-invalidate`}
                          onClick={() => void handlePayerInvalidate(snapshot)}
                          disabled={!activeId || payerSaving}
                        >
                          snapshot 무효화
                        </button>
                      </div>
                    ) : null}
                  </div>
                ))
              ) : (
                <div className="recipient-muted">등록된 납부자 snapshot이 없습니다.</div>
              )}
            </div>
            <form
              className="recipient-payer-form"
              data-testid="recipient-payer-form"
              onSubmit={handlePayerSubmit}
            >
              <div className="recipient-subsection-heading">
                <h3>{editingPayerSnapshotId ? '납부자 snapshot 교체' : '납부자 snapshot 지정'}</h3>
                {editingPayerSnapshotId ? (
                  <button
                    className="recipient-secondary-button"
                    type="button"
                    onClick={() => {
                      setEditingPayerSnapshotId(null);
                      setPayerForm(emptyPayerForm());
                    }}
                  >
                    새 snapshot
                  </button>
                ) : null}
              </div>
              <div className="recipient-form-grid">
                <label className="recipient-field">
                  납부자 이름 <em>필수</em>
                  <input
                    data-testid="recipient-payer-name-input"
                    value={payerForm.name}
                    onChange={(event) => setPayerForm((current) => ({ ...current, name: event.target.value }))}
                    required
                    disabled={!activeId || payerSaving}
                  />
                </label>
                <label className="recipient-field">
                  전화
                  <input
                    data-testid="recipient-payer-phone-input"
                    value={payerForm.phone}
                    onChange={(event) => setPayerForm((current) => ({ ...current, phone: event.target.value }))}
                    disabled={!activeId || payerSaving}
                  />
                </label>
                <label className="recipient-field">
                  관계
                  <input
                    data-testid="recipient-payer-relationship-input"
                    value={payerForm.relationship_text}
                    onChange={(event) =>
                      setPayerForm((current) => ({ ...current, relationship_text: event.target.value }))
                    }
                    disabled={!activeId || payerSaving}
                  />
                </label>
                <label className="recipient-field recipient-field-wide">
                  주소
                  <input
                    data-testid="recipient-payer-address-input"
                    value={payerForm.address}
                    onChange={(event) => setPayerForm((current) => ({ ...current, address: event.target.value }))}
                    disabled={!activeId || payerSaving}
                  />
                </label>
                <label className="recipient-field">
                  시작일 <em>필수</em>
                  <input
                    data-testid="recipient-payer-start-date-input"
                    type="date"
                    value={payerForm.start_date}
                    onChange={(event) => setPayerForm((current) => ({ ...current, start_date: event.target.value }))}
                    required
                    disabled={!activeId || payerSaving}
                  />
                </label>
                <label className="recipient-field">
                  종료일
                  <input
                    data-testid="recipient-payer-end-date-input"
                    type="date"
                    value={payerForm.end_date}
                    onChange={(event) => setPayerForm((current) => ({ ...current, end_date: event.target.value }))}
                    disabled={!activeId || payerSaving}
                  />
                </label>
              </div>
              {payerError ? <div className="recipient-inline-error">{payerError}</div> : null}
              {payerMessage ? <div className="recipient-inline-note">{payerMessage}</div> : null}
              <button
                className="recipient-secondary-button"
                type="submit"
                disabled={!activeId || payerSaving}
              >
                {payerSaving
                  ? '저장 중…'
                  : editingPayerSnapshotId
                    ? '납부자 snapshot 교체'
                    : '납부자 snapshot 지정'}
              </button>
            </form>
          </section>
          )}
          {activeId ? <RecipientW1cPanel recipientId={activeId} /> : null}
          <section
            className="recipient-subsection"
            data-testid="recipient-plan-notification-section"
          >
            <div className="recipient-subsection-heading">
              <h3>계획서 통보일 이력</h3>
            </div>
            <div className="recipient-history-list">
              {planNotifications.length ? (
                planNotifications.map((row) => (
                  <div className="recipient-history-card" key={row.id}>
                    <strong>{row.notified_date}</strong>
                    <span>{row.invalidated_at_utc ? '무효화됨' : '유효'}</span>
                    {!row.invalidated_at_utc ? (
                      <div className="recipient-history-card-actions">
                        <button
                          type="button"
                          data-testid={`recipient-plan-notification-${row.id}-invalidate`}
                          onClick={() => void handlePlanNotificationInvalidate(row)}
                          disabled={planNotificationSaving}
                        >
                          통보일 무효화
                        </button>
                      </div>
                    ) : null}
                  </div>
                ))
              ) : (
                <div className="recipient-muted">등록된 계획서 통보일이 없습니다.</div>
              )}
            </div>
            <form
              className="recipient-subform"
              data-testid="recipient-plan-notification-form"
              onSubmit={handlePlanNotificationSubmit}
            >
              <div className="recipient-form-grid">
                <label className="recipient-field">
                  계획서 통보일
                  <input
                    data-testid="recipient-plan-notification-date-input"
                    type="date"
                    value={planNotificationDate}
                    onChange={(event) => setPlanNotificationDate(event.target.value)}
                    required
                    disabled={planNotificationSaving}
                  />
                </label>
              </div>
              {planNotificationError ? <div className="recipient-inline-error">{planNotificationError}</div> : null}
              {planNotificationMessage ? <div className="recipient-inline-note">{planNotificationMessage}</div> : null}
              <button
                className="recipient-primary-button"
                type="submit"
                data-testid="recipient-plan-notification-submit"
                disabled={planNotificationSaving || !activeId}
              >
                {planNotificationSaving ? '저장 중…' : '통보일 저장'}
              </button>
            </form>
          </section>
          {activeId ? (
            <RecipientContractPanel
              recipientId={activeId}
              recipientNo={detailViewRecipient?.recipient_no ?? null}
              onRecipientMutated={() => {
                setListReload((current) => current + 1);
                setWorkspaceReload((current) => current + 1);
              }}
            />
          ) : null}
        </section>
      </div>
    </div>
  );
};

export default RecipientsPage;

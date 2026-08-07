import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { FormEvent, UIEvent } from 'react';
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
  isRecipientStatus,
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
  RecipientListItem,
  RecipientListResponse,
  RecipientListServiceGroupItem,
  RecipientListStatusFilter,
  RecipientSexCode,
  RecipientStatus,
  RecipientUpdateRequest,
} from '../services/recipientApi';

type RecipientFormState = {
  name: string;
  birth_date: string;
  sex_code: RecipientSexCode;
  recipient_status: RecipientStatus;
  postal_code: string;
  address: string;
  address_detail: string;
  home_phone: string;
  mobile_phone: string;
  memo: string;
};

type RecipientEditableField =
  | 'name'
  | 'birth_date'
  | 'sex_code'
  | 'recipient_status'
  | 'postal_code'
  | 'address'
  | 'home_phone'
  | 'mobile_phone'
  | 'memo';

type RecipientFieldConflict = {
  field: RecipientEditableField;
  label: string;
  userValue: string;
  serverValue: string;
};

type RecipientStaleConflict = {
  original: Recipient;
  latest: Recipient;
  draftAtConflict: RecipientFormState;
  sameFieldConflicts: RecipientFieldConflict[];
  /** When false, same-field collision: no automatic reapply; form shows server latest. */
  canAutoReapply: boolean;
};

type GuardianFormState = {
  name: string;
  phone: string;
  postal_code: string;
  address: string;
  address_detail: string;
  relationship_text: string;
  email: string;
};

type GuardianSlot = 0 | 1;
type GuardianFormSlots = [GuardianFormState, GuardianFormState];

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

/** UI display order: 이용중, 전체, 계약종료, 대기중 */
const LIST_STATUS_FILTERS: readonly RecipientListStatusFilter[] = [
  'ACTIVE',
  'ALL',
  'ENDED',
  'WAITING',
];

const LIST_STATUS_LABELS: Record<RecipientListStatusFilter, string> = {
  ACTIVE: '이용중',
  ALL: '전체',
  ENDED: '계약종료',
  WAITING: '대기중',
};

function parseStatusFilter(rawValue: string | null): RecipientListStatusFilter {
  if (rawValue && (LIST_STATUS_FILTERS as readonly string[]).includes(rawValue)) {
    return rawValue as RecipientListStatusFilter;
  }
  // First screen / missing URL status defaults to ACTIVE (UI). API default remains ALL when omitted.
  return 'ACTIVE';
}

/**
 * Read-only list projection for summary display (name/grade context only).
 * Never use this as an editable detail form source or PATCH payload base:
 * list rows do not carry recipient_status; inventing ACTIVE would overwrite real tags.
 */
function recipientIdentityFromListItem(item: RecipientListItem): Recipient {
  return {
    id: item.id,
    name: item.name,
    birth_date: item.birth_date,
    sex_code: item.sex_code,
    // Placeholder only for TypeScript Recipient shape; not used for edit/PATCH.
    recipient_status: 'ACTIVE',
    recipient_no: item.recipient_no,
    postal_code: item.postal_code,
    address: item.address,
    home_phone: item.home_phone,
    mobile_phone: item.mobile_phone,
    memo: item.memo,
    row_version: item.row_version,
  };
}

/** Patch list-row identity fields after detail save; keep server projection columns. */
function mergeRecipientIntoListItem(
  item: RecipientListItem,
  recipient: Recipient,
): RecipientListItem {
  return {
    ...item,
    id: recipient.id,
    name: recipient.name,
    birth_date: recipient.birth_date,
    sex_code: recipient.sex_code,
    recipient_no: recipient.recipient_no,
    postal_code: recipient.postal_code,
    address: recipient.address,
    home_phone: recipient.home_phone,
    mobile_phone: recipient.mobile_phone,
    memo: recipient.memo,
    row_version: recipient.row_version,
  };
}

function formatGradeCode(value: string | null | undefined): string {
  if (value == null || !String(value).trim()) return '미지정';
  const normalized = String(value).trim();
  return /등급$/.test(normalized) ? normalized : `${normalized}등급`;
}

function formatBenefitCode(value: string | null | undefined): string {
  if (value == null || !String(value).trim()) return '없음';
  return String(value).trim();
}

function formatCopaymentRate(value: number | null | undefined): string {
  if (value == null || Number.isNaN(value)) return '미지정';
  return `${value}%`;
}

function formatListServices(services: RecipientListServiceGroupItem[] | null | undefined): string {
  if (!services?.length) return '없음';
  return services
    .map((group) => {
      const types = group.service_types?.length
        ? group.service_types.map((type) => type.display_name).join(', ')
        : '없음';
      return `${group.display_name}: ${types}`;
    })
    .join(' · ');
}

const emptyRecipientForm = (): RecipientFormState => ({
  name: '',
  birth_date: '',
  sex_code: 'MALE',
  recipient_status: 'ACTIVE',
  postal_code: '',
  address: '',
  address_detail: '',
  home_phone: '',
  mobile_phone: '',
  memo: '',
});

const emptyGuardianForm = (): GuardianFormState => ({
  name: '',
  phone: '',
  postal_code: '',
  address: '',
  address_detail: '',
  relationship_text: '',
  email: '',
});

const guardianFormsFromGuardians = (guardians: Guardian[]): GuardianFormSlots => [
  guardians[0] ? guardianFormFromGuardian(guardians[0]) : emptyGuardianForm(),
  guardians[1] ? guardianFormFromGuardian(guardians[1]) : emptyGuardianForm(),
];

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

function formatMobilePhoneInput(value: string): string {
  const digits = value.replace(/\D/g, '');
  const localDigits = (digits.startsWith('010') ? digits.slice(3) : digits).slice(0, 8);
  if (!localDigits) return '010-';
  if (localDigits.length <= 4) return `010-${localDigits}`;
  return `010-${localDigits.slice(0, 4)}-${localDigits.slice(4)}`;
}

function combinedRecipientAddress(form: RecipientFormState): string | null {
  return optionalText([form.address, form.address_detail].filter((value) => value.trim()).join(' '));
}

function recipientCreatePayload(form: RecipientFormState): RecipientCreateRequest {
  return {
    name: form.name.trim(),
    birth_date: form.birth_date,
    sex_code: form.sex_code,
    postal_code: optionalText(form.postal_code),
    address: combinedRecipientAddress(form),
    home_phone: optionalText(form.home_phone),
    mobile_phone: optionalText(form.mobile_phone),
    memo: optionalText(form.memo),
  };
}

const RECIPIENT_FIELD_LABELS: Record<RecipientEditableField, string> = {
  name: '이름',
  birth_date: '생년월일',
  sex_code: '성별',
  recipient_status: '상태',
  postal_code: '우편번호',
  address: '주소',
  home_phone: '자택 전화',
  mobile_phone: '휴대전화',
  memo: '출처 메모',
};

function formatFieldDisplay(value: string | null | undefined): string {
  if (value == null || value === '') return '없음';
  return value;
}

/**
 * Shared normalization for draft vs baseline dirty comparison and PATCH diffs.
 * Trim text, empty/whitespace-only optional fields → null (same as form payload).
 */
function recipientComparableValues(recipient: Recipient): Record<RecipientEditableField, string | null> {
  return {
    name: recipient.name.trim(),
    birth_date: recipient.birth_date,
    sex_code: recipient.sex_code,
    recipient_status: recipient.recipient_status,
    postal_code: optionalText(recipient.postal_code ?? ''),
    address: optionalText(recipient.address ?? ''),
    home_phone: optionalText(recipient.home_phone ?? ''),
    mobile_phone: optionalText(recipient.mobile_phone ?? ''),
    memo: optionalText(recipient.memo ?? ''),
  };
}

function formComparableValues(form: RecipientFormState): Record<RecipientEditableField, string | null> {
  return {
    name: form.name.trim(),
    birth_date: form.birth_date,
    sex_code: form.sex_code,
    recipient_status: form.recipient_status,
    postal_code: optionalText(form.postal_code),
    address: combinedRecipientAddress(form),
    home_phone: optionalText(form.home_phone),
    mobile_phone: optionalText(form.mobile_phone),
    memo: optionalText(form.memo),
  };
}

function changedRecipientFields(
  baseline: Recipient,
  draft: RecipientFormState,
): RecipientEditableField[] {
  const base = recipientComparableValues(baseline);
  const next = formComparableValues(draft);
  return (Object.keys(base) as RecipientEditableField[]).filter((key) => base[key] !== next[key]);
}

function serverChangedRecipientFields(original: Recipient, latest: Recipient): RecipientEditableField[] {
  const a = recipientComparableValues(original);
  const b = recipientComparableValues(latest);
  return (Object.keys(a) as RecipientEditableField[]).filter((key) => a[key] !== b[key]);
}

/** PATCH body with only fields that differ from baseline (omit untouched, e.g. status). */
function recipientChangedFieldsPayload(
  baseline: Recipient,
  draft: RecipientFormState,
  expectedRowVersion: number,
): RecipientUpdateRequest {
  const payload: RecipientUpdateRequest = { expected_row_version: expectedRowVersion };
  const changed = changedRecipientFields(baseline, draft);
  const next = formComparableValues(draft);
  for (const field of changed) {
    if (field === 'name') payload.name = next.name ?? undefined;
    else if (field === 'birth_date') payload.birth_date = next.birth_date;
    else if (field === 'sex_code') payload.sex_code = next.sex_code as RecipientSexCode;
    else if (field === 'recipient_status') {
      payload.recipient_status = next.recipient_status as RecipientStatus;
    } else if (field === 'postal_code') payload.postal_code = next.postal_code;
    else if (field === 'address') payload.address = next.address;
    else if (field === 'home_phone') payload.home_phone = next.home_phone;
    else if (field === 'mobile_phone') payload.mobile_phone = next.mobile_phone;
    else if (field === 'memo') payload.memo = next.memo;
  }
  return payload;
}

function recipientHasDraftChanges(baseline: Recipient, draft: RecipientFormState): boolean {
  return changedRecipientFields(baseline, draft).length > 0;
}

/**
 * Runtime-validate detail GET before opening the editor.
 * Rejects wrong id, missing/null/invalid recipient_status, or incomplete identity.
 */
function validateDetailRecipient(raw: unknown, expectedId: string): Recipient | null {
  if (raw === null || typeof raw !== 'object') return null;
  const candidate = raw as Partial<Recipient>;
  if (normalizeId(candidate.id) !== expectedId) return null;
  if (!isRecipientStatus(candidate.recipient_status)) return null;
  if (typeof candidate.row_version !== 'number' || !(candidate.row_version > 0)) return null;
  if (typeof candidate.name !== 'string' || !candidate.name.trim()) return null;
  if (typeof candidate.birth_date !== 'string' || !candidate.birth_date) return null;
  if (candidate.sex_code !== 'MALE' && candidate.sex_code !== 'FEMALE') return null;
  return candidate as Recipient;
}

function recipientFormFromRecipient(recipient: Recipient): RecipientFormState {
  return {
    name: recipient.name,
    birth_date: recipient.birth_date,
    sex_code: recipient.sex_code,
    recipient_status: recipient.recipient_status,
    postal_code: recipient.postal_code ?? '',
    address: recipient.address ?? '',
    address_detail: '',
    home_phone: recipient.home_phone ?? '',
    mobile_phone: recipient.mobile_phone ?? '',
    memo: recipient.memo ?? '',
  };
}

/**
 * Merge user-changed fields from draft onto latest server values.
 * When excludeFields is set (same-field conflicts), those fields stay at server latest;
 * only disjoint user edits are preserved.
 */
function mergeUserChangesOntoLatest(
  latest: Recipient,
  original: Recipient,
  draft: RecipientFormState,
  excludeFields?: ReadonlySet<RecipientEditableField>,
): RecipientFormState {
  const merged = recipientFormFromRecipient(latest);
  const userChanged = changedRecipientFields(original, draft);
  const draftValues = formComparableValues(draft);
  for (const field of userChanged) {
    if (excludeFields?.has(field)) continue;
    if (field === 'name') merged.name = draftValues.name ?? '';
    else if (field === 'birth_date') merged.birth_date = draftValues.birth_date ?? '';
    else if (field === 'sex_code') merged.sex_code = (draftValues.sex_code as RecipientSexCode) ?? 'MALE';
    else if (field === 'recipient_status') {
      merged.recipient_status = (draftValues.recipient_status as RecipientStatus) ?? 'ACTIVE';
    } else if (field === 'postal_code') merged.postal_code = draftValues.postal_code ?? '';
    else if (field === 'address') {
      merged.address = draftValues.address ?? '';
      merged.address_detail = '';
    } else if (field === 'home_phone') merged.home_phone = draftValues.home_phone ?? '';
    else if (field === 'mobile_phone') merged.mobile_phone = draftValues.mobile_phone ?? '';
    else if (field === 'memo') merged.memo = draftValues.memo ?? '';
  }
  return merged;
}

function guardianFormFromGuardian(guardian: Guardian): GuardianFormState {
  return {
    name: guardian.name,
    phone: guardian.phone ?? '',
    postal_code: '',
    address: guardian.address ?? '',
    address_detail: '',
    relationship_text: guardian.relationship_text ?? '',
    email: '',
  };
}

function combinedGuardianAddress(form: GuardianFormState): string | null {
  return optionalText([form.address, form.address_detail].filter((value) => value.trim()).join(' '));
}

function guardianPayload(form: GuardianFormState): GuardianCreateRequest {
  return {
    name: form.name.trim(),
    phone: optionalText(form.phone),
    address: combinedGuardianAddress(form),
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

/** Validate list response contract fields used for infinite scroll. */
function isValidListResponse(response: RecipientListResponse): boolean {
  if (!response || typeof response !== 'object') return false;
  if (!Array.isArray(response.items)) return false;
  if (typeof response.total !== 'number' || !Number.isFinite(response.total) || response.total < 0) {
    return false;
  }
  if (typeof response.page !== 'number' || !Number.isFinite(response.page) || response.page < 1) {
    return false;
  }
  if (
    typeof response.page_size !== 'number' ||
    !Number.isFinite(response.page_size) ||
    response.page_size < 1
  ) {
    return false;
  }
  return true;
}

/** Append incoming rows, dropping duplicates by recipient id. */
function appendItemsById(
  existing: RecipientListItem[],
  incoming: RecipientListItem[],
): RecipientListItem[] {
  const seen = new Set(existing.map((item) => item.id));
  const merged = [...existing];
  for (const item of incoming) {
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    merged.push(item);
  }
  return merged;
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

function normalizeId(value: number | string | null | undefined): string | null {
  return value === null || value === undefined ? null : String(value);
}

function formatRecipientNo(value: string | null | undefined): string {
  return value?.trim() ? value : '미부여';
}

function formatNullable(value: string | null | undefined): string {
  return value?.trim() ? value : '없음';
}

/** Calendar Y/M/D in Asia/Seoul (not the host local timezone). */
function seoulCalendarParts(date: Date): { year: number; month: number; day: number } | null {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Seoul',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const year = Number(parts.find((part) => part.type === 'year')?.value);
  const month = Number(parts.find((part) => part.type === 'month')?.value);
  const day = Number(parts.find((part) => part.type === 'day')?.value);
  if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) return null;
  return { year, month, day };
}

/** International/Korean full age (만 나이): years since birth, minus 1 if birthday not yet reached. */
function formatInternationalAge(birthDate: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(birthDate)) return '미지정';
  const [yearStr, monthStr, dayStr] = birthDate.split('-');
  const birthYear = Number(yearStr);
  const birthMonth = Number(monthStr);
  const birthDay = Number(dayStr);
  // Birth dates are date-only; validate real calendar day without host-local wall time.
  const birthProbe = new Date(Date.UTC(birthYear, birthMonth - 1, birthDay));
  if (
    Number.isNaN(birthProbe.getTime()) ||
    birthProbe.getUTCFullYear() !== birthYear ||
    birthProbe.getUTCMonth() + 1 !== birthMonth ||
    birthProbe.getUTCDate() !== birthDay
  ) {
    return '미지정';
  }

  const seoul = seoulCalendarParts(new Date());
  if (!seoul) return '미지정';

  // Future relative to the current Asia/Seoul calendar day → 미지정.
  if (
    birthYear > seoul.year ||
    (birthYear === seoul.year && birthMonth > seoul.month) ||
    (birthYear === seoul.year && birthMonth === seoul.month && birthDay > seoul.day)
  ) {
    return '미지정';
  }

  let age = seoul.year - birthYear;
  const birthdayPassed =
    seoul.month > birthMonth || (seoul.month === birthMonth && seoul.day >= birthDay);
  if (!birthdayPassed) age -= 1;
  return age >= 0 ? `${age}세` : '미지정';
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
  /** Last successfully loaded search/status key; used to detect filter resets. */
  const listFilterKeyRef = useRef<string | null>(null);
  /** Last successfully loaded API page for the current filter (append cursor). */
  const loadedPageRef = useRef(0);
  /** Monotonic generation: search/status/listReload bumps so late responses are ignored. */
  const listFetchGenRef = useRef(0);
  /** In-flight append guard (sync) so the same next page is not requested twice. */
  const listLoadingMoreRef = useRef(false);
  const listLoadMoreAbortRef = useRef<AbortController | null>(null);
  const [recipientForm, setRecipientForm] = useState<RecipientFormState>(emptyRecipientForm);
  const [createOpen, setCreateOpen] = useState(false);
  const [detailExtrasOpen, setDetailExtrasOpen] = useState(false);
  const [createSaving, setCreateSaving] = useState(false);
  const [createMessage, setCreateMessage] = useState<string | null>(null);
  const [createError, setCreateError] = useState<string | null>(null);
  const [listData, setListData] = useState<RecipientListResponse | null>(null);
  const [listLoading, setListLoading] = useState(true);
  const [listLoadingMore, setListLoadingMore] = useState(false);
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
  const [guardianForms, setGuardianForms] = useState<GuardianFormSlots>(guardianFormsFromGuardians([]));
  const [guardianEditSnapshots, setGuardianEditSnapshots] = useState<GuardianFormSlots>(guardianFormsFromGuardians([]));
  const [editingGuardianIds, setEditingGuardianIds] = useState<[string | null, string | null]>([null, null]);
  const [guardianEditOpen, setGuardianEditOpen] = useState<[boolean, boolean]>([false, false]);
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
  // URL may keep a display key (`filter`); server query must be `status`.
  const statusFilter = parseStatusFilter(query.get('status') ?? query.get('filter'));
  const selectedId = query.get('selected');
  const detailId = query.get('detail');
  const activeId = detailId ?? selectedId;

  const cancelCreate = useCallback(() => {
    if (createSaving) return;
    setCreateOpen(false);
    setCreateError(null);
    setCreateMessage(null);
    setRecipientForm(emptyRecipientForm());
  }, [createSaving]);

  useEffect(() => {
    if (!createOpen) return;
    const handleCreateEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        cancelCreate();
      }
    };
    window.addEventListener('keydown', handleCreateEscape);
    return () => window.removeEventListener('keydown', handleCreateEscape);
  }, [cancelCreate, createOpen]);

  useEffect(() => {
    setDetailExtrasOpen(false);
  }, [activeId]);

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

  // First screen must explicitly use status=ACTIVE in the URL (API default remains ALL when omitted).
  useEffect(() => {
    const params = new URLSearchParams(location.search);
    if (!params.get('status') && !params.get('filter')) {
      updateQuery({ status: 'ACTIVE' }, true);
    }
  }, [location.search, updateQuery]);

  const selectedRecipient = useMemo(
    () =>
      (selectedId
        ? listData?.items.find((item) => normalizeId(item.id) === selectedId) ?? null
        : listData?.items[0] ?? null),
    [listData, selectedId],
  );

  // Server owns sort/filter/paging; client appends pages in response order.
  const visibleRecipients = listData?.items ?? [];
  const listTotal = listData?.total ?? 0;
  const listHasMore =
    listData != null &&
    typeof listData.total === 'number' &&
    Number.isFinite(listData.total) &&
    listData.items.length < listData.total;

  // First load / search / status / listReload: page 1 replace (reset cursor + rows on filter change).
  useEffect(() => {
    const controller = new AbortController();
    const filterKey = `${search}\0${statusFilter}`;
    const isFilterChange =
      listFilterKeyRef.current !== null && listFilterKeyRef.current !== filterKey;
    const fetchGen = ++listFetchGenRef.current;

    // Cancel any in-flight append so a late page-2 cannot land under a new filter.
    listLoadMoreAbortRef.current?.abort();
    listLoadMoreAbortRef.current = null;
    listLoadingMoreRef.current = false;
    setListLoadingMore(false);
    loadedPageRef.current = 0;

    setListLoading(true);
    setListError(null);
    // Drop prior projection immediately on search/status change so old
    // rows/total never sit under the new query while loading.
    if (isFilterChange) {
      setListData(null);
    }

    listRecipients({
      search,
      status: statusFilter,
      page: 1,
      pageSize: PAGE_SIZE,
      signal: controller.signal,
    })
      .then((response) => {
        if (fetchGen !== listFetchGenRef.current) return;
        if (!isValidListResponse(response)) {
          setListLoading(false);
          setListData(null);
          loadedPageRef.current = 0;
          setListError('수급자 목록 응답이 올바르지 않습니다.');
          return;
        }
        listFilterKeyRef.current = filterKey;
        loadedPageRef.current = response.page;
        setListData({
          items: response.items,
          total: response.total,
          page: response.page,
          page_size: response.page_size,
        });
        setListLoading(false);

        // After a search/status change, drop selected/detail that are not in the
        // first page (preserve search/status). Apply first-row selection when
        // selected is gone. Skip on initial load so deep-links remain.
        if (!isFilterChange) return;
        const current = new URLSearchParams(readBrowserLocation().search);
        const curSelected = current.get('selected');
        const curDetail = current.get('detail');
        const pageIds = new Set(
          response.items
            .map((item) => normalizeId(item.id))
            .filter((id): id is string => id !== null),
        );
        const updates: Record<string, string | null> = {};
        if (curSelected && !pageIds.has(curSelected)) {
          updates.selected = response.items.length
            ? normalizeId(response.items[0].id)
            : null;
        }
        if (curDetail && !pageIds.has(curDetail)) {
          updates.detail = null;
        }
        if (Object.keys(updates).length > 0) {
          updateQuery(updates, true);
        }
      })
      .catch((error: unknown) => {
        if (fetchGen !== listFetchGenRef.current || isAbortError(error)) return;
        setListLoading(false);
        setListData(null);
        loadedPageRef.current = 0;
        setListError(safeErrorMessage(error, '수급자 목록을 불러오지 못했습니다.'));
      });

    return () => {
      controller.abort();
    };
  }, [listReload, search, statusFilter, updateQuery]);

  const loadMoreRecipients = useCallback(() => {
    if (listLoading || listLoadingMoreRef.current) return;
    if (!listData || !listHasMore) return;
    if (typeof listData.total !== 'number' || !Number.isFinite(listData.total)) return;

    const nextPage = loadedPageRef.current + 1;
    if (nextPage < 2) return;

    const fetchGen = listFetchGenRef.current;
    const controller = new AbortController();
    // Single in-flight append: filter resets abort via listLoadMoreAbortRef.
    listLoadMoreAbortRef.current = controller;
    listLoadingMoreRef.current = true;
    setListLoadingMore(true);
    setListError(null);

    listRecipients({
      search,
      status: statusFilter,
      page: nextPage,
      pageSize: PAGE_SIZE,
      signal: controller.signal,
    })
      .then((response) => {
        if (fetchGen !== listFetchGenRef.current) return;
        if (!isValidListResponse(response)) {
          setListError('수급자 목록 응답이 올바르지 않습니다.');
          return;
        }
        setListData((current) => {
          if (!current || fetchGen !== listFetchGenRef.current) return current;
          const items = appendItemsById(current.items, response.items);
          loadedPageRef.current = response.page;
          return {
            items,
            total: response.total,
            page: response.page,
            page_size: response.page_size,
          };
        });
      })
      .catch((error: unknown) => {
        if (fetchGen !== listFetchGenRef.current || isAbortError(error)) return;
        // Keep already-loaded rows; surface append failure without inventing totals.
        setListError(safeErrorMessage(error, '수급자 목록을 더 불러오지 못했습니다.'));
      })
      .finally(() => {
        if (fetchGen !== listFetchGenRef.current) return;
        listLoadingMoreRef.current = false;
        setListLoadingMore(false);
        if (listLoadMoreAbortRef.current === controller) {
          listLoadMoreAbortRef.current = null;
        }
      });
  }, [listData, listHasMore, listLoading, search, statusFilter]);

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
      setGuardianForms(guardianFormsFromGuardians([]));
      setGuardianEditSnapshots(guardianFormsFromGuardians([]));
      setEditingGuardianIds([null, null]);
      setGuardianEditOpen([false, false]);
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
    // Editable detail form requires a successful detail GET. Do not seed form/PATCH
    // state from list rows (list has no recipient_status; synthetic ACTIVE is unsafe).
    setDetailRecipient(null);
    setDetailForm(emptyRecipientForm());
    setGuardians([]);
    setGuardianForms(guardianFormsFromGuardians([]));
    setGuardianEditSnapshots(guardianFormsFromGuardians([]));
    setGuardianEditOpen([false, false]);
    setEditingGuardianIds([null, null]);

    Promise.allSettled([
      getRecipient(activeId, controller.signal),
      listGuardians(activeId, controller.signal),
      listPrimaryGuardianPeriods(activeId, controller.signal),
      listPayerSnapshots(activeId, controller.signal),
    ]).then(([recipientResult, guardianResult, periodResult, payerResult]) => {
      if (cancelled) return;

      const rawRecipient = valueFromResult(recipientResult);
      const embedded = (valueFromResult(recipientResult) as EmbeddedRecipient | undefined) ?? null;
      const embeddedGuardians = embedded?.guardians ?? [];
      const guardianResponse = valueFromResult(guardianResult);
      const periodResponse = valueFromResult(periodResult);
      const payerResponse = valueFromResult(payerResult);
      const resolvedGuardians = guardianResponse?.items ?? embeddedGuardians;

      const validated =
        rawRecipient && activeId
          ? validateDetailRecipient(rawRecipient, activeId)
          : null;

      if (validated) {
        setDetailRecipient(validated);
        setDetailForm(recipientFormFromRecipient(validated));
        setDetailStaleConflict(null);
      } else if (recipientResult.status === 'rejected') {
        setDetailRecipient(null);
        setDetailForm(emptyRecipientForm());
        setDetailError(safeErrorMessage(recipientResult.reason, '수급자 상세를 불러오지 못했습니다.'));
      } else {
        setDetailRecipient(null);
        setDetailForm(emptyRecipientForm());
        setDetailError(
          rawRecipient
            ? '수급자 상세 응답이 올바르지 않아 편집할 수 없습니다.'
            : '수급자 상세를 불러오지 못했습니다.',
        );
      }

      setGuardians(resolvedGuardians);
      setGuardianForms(guardianFormsFromGuardians(resolvedGuardians));
      setGuardianEditSnapshots(guardianFormsFromGuardians(resolvedGuardians));
      setGuardianEditOpen([false, false]);
      setEditingGuardianIds([
        resolvedGuardians[0] ? normalizeId(resolvedGuardians[0].id) : null,
        resolvedGuardians[1] ? normalizeId(resolvedGuardians[1].id) : null,
      ]);
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
    // Do not depend on listData: successful detail PATCH updates the list row and
    // bumps listReload → new listData. Re-running this effect would clear
    // detailRecipient/form (and wipe 422 draft + role=alert errors) mid-edit, so
    // status-only follow-up PATCH and validation error UI would never land.
    // Detail reloads only on activeId change, explicit workspaceReload, or
    // stale-conflict lifecycle (detailStaleConflict).
  }, [activeId, detailStaleConflict, workspaceReload]);

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
    if (!recipientForm.mobile_phone.trim()) {
      setCreateError('휴대전화를 입력해주세요.');
      return;
    }

    setCreateSaving(true);
    try {
      const createdRaw = await createRecipient(recipientCreatePayload(recipientForm));
      const createdEmbedded = createdRaw as EmbeddedRecipient;
      const createdId = normalizeId(createdRaw.id);
      const created =
        createdId != null ? validateDetailRecipient(createdRaw, createdId) : null;
      setCreateMessage('수급자를 저장했습니다.');
      setRecipientForm(emptyRecipientForm());
      if (created) {
        setDetailRecipient(created);
        setDetailForm(recipientFormFromRecipient(created));
      } else {
        setDetailRecipient(null);
        setDetailForm(emptyRecipientForm());
      }
      const createdGuardians = createdEmbedded.guardians ?? [];
      setGuardians(createdGuardians);
      setGuardianForms(guardianFormsFromGuardians(createdGuardians));
      setGuardianEditSnapshots(guardianFormsFromGuardians(createdGuardians));
      setGuardianEditOpen([false, false]);
      setEditingGuardianIds([
        createdGuardians[0] ? normalizeId(createdGuardians[0].id) : null,
        createdGuardians[1] ? normalizeId(createdGuardians[1].id) : null,
      ]);
      updateQuery(
        {
          selected: createdId,
          detail: createdId,
        },
        false,
      );
      setListReload((current) => current + 1);
      setCreateOpen(false);
    } catch (error: unknown) {
      if (!isAbortError(error)) {
        setCreateError(safeErrorMessage(error, '수급자를 저장하지 못했습니다.'));
      }
    } finally {
      setCreateSaving(false);
    }
  };

  const captureRecipientStaleConflict = async (
    original: Recipient,
    draft: RecipientFormState,
  ): Promise<void> => {
    try {
      const rawLatest = await getRecipient(activeId ?? '');
      const latest =
        activeId != null ? validateDetailRecipient(rawLatest, activeId) : null;
      if (!latest) {
        setDetailError('저장 충돌 후 대상 수급자의 최신 정보를 확인하지 못했습니다. 입력은 유지됩니다.');
        return;
      }

      const userChanged = new Set(changedRecipientFields(original, draft));
      const serverChanged = new Set(serverChangedRecipientFields(original, latest));
      const sameFields = [...userChanged].filter((field) => serverChanged.has(field));
      const sameFieldSet = new Set(sameFields);
      const draftValues = formComparableValues(draft);
      const latestValues = recipientComparableValues(latest);
      const sameFieldConflicts: RecipientFieldConflict[] = sameFields.map((field) => ({
        field,
        label: RECIPIENT_FIELD_LABELS[field],
        userValue: formatFieldDisplay(draftValues[field]),
        serverValue: formatFieldDisplay(latestValues[field]),
      }));

      if (sameFieldConflicts.length > 0) {
        // Same-field collision: server wins only for colliding fields; preserve disjoint user edits.
        // Active baseline/row_version become latest; next PATCH diffs current form vs that baseline.
        const merged = mergeUserChangesOntoLatest(latest, original, draft, sameFieldSet);
        setDetailRecipient(latest);
        setDetailForm(merged);
        setDetailStaleConflict({
          original,
          latest,
          draftAtConflict: draft,
          sameFieldConflicts,
          canAutoReapply: false,
        });
        setDetailError('이미 수정되었습니다');
        return;
      }

      // Different fields only: preserve user draft values on top of latest baseline.
      const merged = mergeUserChangesOntoLatest(latest, original, draft);
      setDetailRecipient(latest);
      setDetailForm(merged);
      setDetailStaleConflict({
        original,
        latest,
        draftAtConflict: draft,
        sameFieldConflicts: [],
        canAutoReapply: true,
      });
      setDetailError(
        '다른 사용자가 먼저 변경했습니다. 최신 서버값을 확인하고 필요한 변경만 다시 적용해주세요.',
      );
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
    // PATCH only after a successful detail GET (never from list-only identity).
    if (!detailRecipient || !activeId || detailLoading || detailSaving) return;
    if (!recipientHasDraftChanges(detailRecipient, detailForm)) return;
    // Freeze request baseline/draft at click so in-flight UI cannot change the payload.
    const baselineAtSave = detailRecipient;
    const draftAtSave = detailForm;
    setDetailMessage(null);
    setDetailError(null);
    setDetailSaving(true);
    try {
      const updatedRaw = await updateRecipient(
        activeId,
        recipientChangedFieldsPayload(
          baselineAtSave,
          draftAtSave,
          baselineAtSave.row_version,
        ),
      );
      const updated = validateDetailRecipient(updatedRaw, activeId);
      if (!updated) {
        setDetailError('저장 응답이 올바르지 않습니다. 다시 불러와 주세요.');
        return;
      }
      setDetailRecipient(updated);
      setDetailForm(recipientFormFromRecipient(updated));
      setDetailStaleConflict(null);
      setListData((current) =>
        current
          ? {
              ...current,
              items: current.items.map((item) =>
                normalizeId(item.id) === activeId
                  ? mergeRecipientIntoListItem(item, updated)
                  : item,
              ),
            }
          : current,
      );
      setDetailMessage('수급자 정보를 저장했습니다.');
      setListReload((current) => current + 1);
    } catch (error: unknown) {
      if (!isAbortError(error)) {
        if (isApiErrorCode(error, 'ROW_VERSION_CONFLICT')) {
          await captureRecipientStaleConflict(baselineAtSave, draftAtSave);
        } else {
          setDetailError(safeErrorMessage(error, '수급자 정보를 저장하지 못했습니다.'));
        }
      }
    } finally {
      setDetailSaving(false);
    }
  };

  const handleDetailReapply = async () => {
    if (!detailStaleConflict || !activeId || !detailStaleConflict.canAutoReapply) return;
    // Always diff the live form against the latest active baseline — never a stale pre-edit snapshot.
    const baseline = detailRecipient ?? detailStaleConflict.latest;
    const draft = detailForm;
    if (!draft.name.trim() || !draft.birth_date || !draft.sex_code) {
      setDetailError('이름, 생년월일, 성별을 입력해주세요.');
      return;
    }
    if (!recipientHasDraftChanges(baseline, draft)) {
      setDetailError(null);
      setDetailStaleConflict(null);
      return;
    }
    setDetailError(null);
    setDetailMessage(null);
    setDetailSaving(true);
    try {
      // Only fields that differ from the current latest baseline (post any user re-edit).
      const updatedRaw = await updateRecipient(
        activeId,
        recipientChangedFieldsPayload(baseline, draft, baseline.row_version),
      );
      const updated = validateDetailRecipient(updatedRaw, activeId);
      if (!updated) {
        setDetailError('다시 적용 응답이 올바르지 않습니다. 다시 불러와 주세요.');
        return;
      }
      setDetailRecipient(updated);
      setDetailForm(recipientFormFromRecipient(updated));
      setDetailStaleConflict(null);
      setDetailError(null);
      setDetailMessage('최신 버전에 변경 내용을 다시 적용했습니다.');
      setListData((current) =>
        current
          ? {
              ...current,
              items: current.items.map((item) =>
                normalizeId(item.id) === activeId
                  ? mergeRecipientIntoListItem(item, updated)
                  : item,
              ),
            }
          : current,
      );
      setListReload((current) => current + 1);
    } catch (error: unknown) {
      if (!isAbortError(error)) {
        if (isApiErrorCode(error, 'ROW_VERSION_CONFLICT')) {
          await captureRecipientStaleConflict(baseline, draft);
        } else {
          setDetailError(safeErrorMessage(error, '변경 내용을 다시 적용하지 못했습니다.'));
        }
      }
    } finally {
      setDetailSaving(false);
    }
  };

  const handleGuardianSubmit = async (event: FormEvent<HTMLFormElement>, guardianIndex: GuardianSlot) => {
    event.preventDefault();
    const form = guardianForms[guardianIndex];
    const editingGuardianId = editingGuardianIds[guardianIndex];
    if (!activeId || !form.name.trim()) {
      setGuardianError('보호자 이름을 입력해주세요.');
      return;
    }
    setGuardianError(null);
    setGuardianMessage(null);
    setGuardianSaving(true);
    try {
      const existing = guardians.find((guardian) => normalizeId(guardian.id) === editingGuardianId);
      const payload = guardianPayload(form);
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
      setEditingGuardianIds((current) => {
        const next: [string | null, string | null] = [current[0], current[1]];
        next[guardianIndex] = normalizeId(saved.id);
        return next;
      });
      setGuardianForms((current) => {
        const next: GuardianFormSlots = [current[0], current[1]];
        next[guardianIndex] = guardianFormFromGuardian(saved);
        return next;
      });
      setGuardianEditSnapshots((current) => {
        const next: GuardianFormSlots = [current[0], current[1]];
        next[guardianIndex] = guardianFormFromGuardian(saved);
        return next;
      });
      setGuardianEditOpen((current) => {
        const next: [boolean, boolean] = [current[0], current[1]];
        next[guardianIndex] = false;
        return next;
      });
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

  const handleListScroll = (event: UIEvent<HTMLDivElement>) => {
    const target = event.currentTarget;
    listScrollTopRef.current = target.scrollTop;
    const remaining = target.scrollHeight - target.scrollTop - target.clientHeight;
    // Near bottom of the list panel (not window): request next page.
    if (remaining <= 80) {
      loadMoreRecipients();
    }
  };

  const activeListRecipient = useMemo(
    () =>
      listData?.items.find((item) => normalizeId(item.id) === activeId) ??
      null,
    [activeId, listData],
  );
  // Grade/copay live only on list projection. Use them solely when the list row id
  // matches the active detail target — never fall back to selectedRecipient (first-row).
  const detailListProjection =
    activeListRecipient && activeId && normalizeId(activeListRecipient.id) === activeId
      ? activeListRecipient
      : null;
  // Summary panel may use list identity for non-status display only.
  // Editable detail form requires detailRecipient from a successful detail GET.
  const detailViewRecipient =
    detailRecipient && normalizeId(detailRecipient.id) === activeId
      ? detailRecipient
      : activeListRecipient
        ? recipientIdentityFromListItem(activeListRecipient)
        : detailId
          ? null
          : selectedRecipient
            ? recipientIdentityFromListItem(selectedRecipient)
            : null;
  // Form only after successful detail GET (detailRecipient never seeded from list).
  // PATCH/validation errors keep detailRecipient so draft remains editable.
  const detailFormReady =
    Boolean(detailRecipient) &&
    normalizeId(detailRecipient?.id) === activeId &&
    !detailLoading;
  const detailSaveEnabled =
    detailFormReady &&
    Boolean(detailRecipient) &&
    !detailSaving &&
    !detailLoading &&
    recipientHasDraftChanges(detailRecipient!, detailForm);
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
        <div
          className="recipient-page-status"
          data-testid="recipient-list-status"
          aria-live="polite"
        >
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
                onChange={(event) =>
                  updateQuery({ search: event.target.value, page: null }, true)
                }
                placeholder="이름 검색"
              />
            </label>
            <label className="recipient-field recipient-filter-field">
              <span className="visually-hidden">상태</span>
              <select
                data-testid="recipient-filter-select"
                value={statusFilter}
                onChange={(event) =>
                  updateQuery(
                    {
                      status: event.target.value,
                      filter: null,
                      page: null,
                    },
                    true,
                  )
                }
              >
                {LIST_STATUS_FILTERS.map((value) => (
                  <option key={value} value={value}>
                    {LIST_STATUS_LABELS[value]}
                  </option>
                ))}
              </select>
            </label>
            <span className="recipient-count" data-testid="recipient-count" aria-live="polite">
              총 {listTotal}명
            </span>
          </div>

          <div className="recipient-list-header" data-testid="recipient-list-header">
            <span>등급</span>
            <span>이름</span>
            <span>나이</span>
            <span>본·부%</span>
            <span>제공중 서비스</span>
          </div>

          <span className="visually-hidden" data-testid="recipient-selected-name">
            {selectedRecipient?.name ?? (selectedId ? '현재 페이지에 없음' : '없음')}
          </span>

          <div
            ref={listScrollRef}
            className="recipient-list-scroll"
            data-testid="recipient-list-scroll"
            onScroll={handleListScroll}
          >
            {listLoading && !visibleRecipients.length ? (
              <div className="recipient-list-row recipient-list-row-placeholder">
                <span data-testid="recipient-list-loading">목록을 불러오는 중입니다.</span>
              </div>
            ) : null}
            {listError ? (
              <div className="recipient-inline-error" role="alert">
                {listError}
              </div>
            ) : null}
            {!listLoading && !listError && !visibleRecipients.length ? (
              <div className="recipient-empty-state">등록된 수급자가 없습니다.</div>
            ) : null}
            {visibleRecipients.map((recipient, index) => {
              const id = normalizeId(recipient.id);
              const isSelected = id === selectedId;
              const listIndex = index + 1;
              const servicesLabel = formatListServices(recipient.services);
              const benefitLabel = formatBenefitCode(recipient.benefit_code);
              const copayLabel = formatCopaymentRate(recipient.copayment_rate);
              const gradeLabel = formatGradeCode(recipient.grade_code);
              return (
                <button
                  className={`recipient-list-row${isSelected ? ' is-selected' : ''}`}
                  data-testid="recipient-name-option"
                  key={id}
                  type="button"
                  onClick={() => openDetail(recipient.id)}
                >
                  <span
                    className="recipient-list-cell recipient-list-grade"
                    data-testid="recipient-list-grade"
                  >
                    {gradeLabel}
                  </span>
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
                  <span className="recipient-list-cell recipient-list-age" data-testid="recipient-list-age">
                    {formatInternationalAge(recipient.birth_date)}
                  </span>
                  <span
                    className="recipient-list-cell recipient-list-copay"
                    data-testid="recipient-list-copay"
                    title={`급여 ${benefitLabel} · 본인부담 ${copayLabel}`}
                  >
                    <span data-testid="recipient-list-benefit">{benefitLabel}</span>
                    <span className="recipient-list-copay-sep" aria-hidden="true">
                      ·
                    </span>
                    <span data-testid="recipient-list-copay-rate">{copayLabel}</span>
                  </span>
                  <span
                    className="recipient-list-cell recipient-list-services"
                    data-testid="recipient-list-services"
                    title={servicesLabel}
                  >
                    {servicesLabel}
                  </span>
                  <span className="visually-hidden recipient-list-row-meta">
                    <span data-testid="recipient-list-recipient-no">
                      {formatRecipientNo(recipient.recipient_no)}
                    </span>
                  </span>
                </button>
              );
            })}
            {listLoadingMore ? (
              <div className="recipient-list-row recipient-list-row-placeholder">
                <span data-testid="recipient-list-loading-more">목록을 더 불러오는 중입니다.</span>
              </div>
            ) : null}
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
            {createError ? (
              <div className="recipient-inline-error" role="alert">
                {createError}
              </div>
            ) : null}
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
          className={`recipient-detail-panel${activeId ? '' : ' is-idle'}${createOpen ? ' is-creating' : ''}`}
          data-testid="recipient-detail-workspace"
        >
          <div className="recipient-detail-heading">
            <div className="recipient-detail-title">
              <h2>{detailViewRecipient?.name ?? '수급자 정보'}</h2>
              <span className="recipient-detail-recipient-no">
                <span>수급자번호</span>
                <strong data-testid="recipient-detail-recipient-no">
                  {formatRecipientNo(detailViewRecipient?.recipient_no)}
                </strong>
              </span>
            </div>
            <div className="recipient-create-actions">
            {!createOpen ? (
              <button
                className="recipient-secondary-button recipient-detail-toggle"
                data-testid="recipient-detail-toggle"
                type="button"
                aria-expanded={detailExtrasOpen}
                onClick={() => setDetailExtrasOpen((current) => !current)}
              >
                세부정보
              </button>
            ) : null}
            <button
              className="recipient-secondary-button recipient-create-trigger"
              data-testid="recipient-create-toggle"
              form={createOpen ? 'recipient-create-form' : undefined}
              type={createOpen ? 'submit' : 'button'}
              aria-expanded={createOpen}
              onClick={createOpen ? undefined : () => {
                setCreateError(null);
                setCreateMessage(null);
                setRecipientForm(emptyRecipientForm());
                setDetailExtrasOpen(false);
                setCreateOpen(true);
              }}
            >
              {createOpen ? '수급자 저장' : '수급자 등록'}
            </button>
            {createOpen ? (
              <button
                className="recipient-secondary-button recipient-create-cancel"
                data-testid="recipient-create-cancel"
                type="button"
                onClick={cancelCreate}
                disabled={createSaving}
              >
                취소
              </button>
            ) : null}
            </div>
          </div>

          {!activeId ? (
            <div className="recipient-idle-message">목록에서 수급자를 선택하세요.</div>
          ) : null}

          {detailLoading ? <div className="recipient-inline-note">상세 정보를 불러오는 중입니다.</div> : null}
          {/* Single accessible alert: non-conflict errors only. Stale conflict owns its own alert. */}
          {detailError && !detailStaleConflict ? (
            <div className="recipient-inline-error" role="alert">
              {detailError}
            </div>
          ) : null}

          {!detailExtrasOpen ? (
            <>
          <section className={`recipient-basic-section${createOpen ? ' is-editing' : ''}`}>
            {createOpen ? (
              <form
                id="recipient-create-form"
                className="recipient-detail-summary recipient-create-summary"
                noValidate
                onSubmit={handleCreateSubmit}
              >
                <label className="recipient-summary-item recipient-create-summary-field">
                  <span>이름</span>
                  <input
                    data-testid="recipient-name-input"
                    value={recipientForm.name}
                    onChange={(event) => setRecipientForm((current) => ({ ...current, name: event.target.value }))}
                  />
                </label>
                <label className="recipient-summary-item recipient-create-summary-field">
                  <span>생년월일</span>
                  <input
                    data-testid="recipient-birth-date-input"
                    type="date"
                    inputMode="numeric"
                    value={recipientForm.birth_date}
                    onChange={(event) => setRecipientForm((current) => ({ ...current, birth_date: event.target.value }))}
                  />
                </label>
                <div className="recipient-summary-item">
                  <span>만 나이</span>
                  <strong>{formatInternationalAge(recipientForm.birth_date)}</strong>
                </div>
                <label className="recipient-summary-item recipient-create-summary-field">
                  <span>성별</span>
                  <select
                    data-testid="recipient-sex-code-select"
                    value={recipientForm.sex_code}
                    onChange={(event) =>
                      setRecipientForm((current) => ({ ...current, sex_code: event.target.value as RecipientSexCode }))
                    }
                  >
                    <option value="MALE">남성</option>
                    <option value="FEMALE">여성</option>
                  </select>
                </label>
                {/*
                  Grade/copay are not on RecipientCreateRequest — do not offer editable
                  controls that look savable. Show contract-honest 미지정 (same as 인정번호).
                */}
                <div className="recipient-summary-item">
                  <span>등급</span>
                  <strong data-testid="recipient-create-grade">미지정</strong>
                </div>
                <div className="recipient-summary-item">
                  <span>인정번호</span>
                  <strong data-testid="recipient-create-certification-number">미지정</strong>
                </div>
                <label className="recipient-summary-item recipient-create-summary-field">
                  <span>휴대전화</span>
                  <input
                    data-testid="recipient-mobile-phone-input"
                    inputMode="tel"
                    placeholder="010-0000-0000"
                    maxLength={13}
                    value={recipientForm.mobile_phone}
                    onFocus={() =>
                      setRecipientForm((current) => ({
                        ...current,
                        mobile_phone: current.mobile_phone || '010-',
                      }))
                    }
                    onChange={(event) =>
                      setRecipientForm((current) => ({
                        ...current,
                        mobile_phone: formatMobilePhoneInput(event.target.value),
                      }))
                    }
                    aria-required="true"
                  />
                </label>
                <div className="recipient-summary-item">
                  <span>본인부담금</span>
                  <strong data-testid="recipient-create-copay">미지정</strong>
                </div>
                <div className="recipient-summary-item recipient-summary-item-address recipient-create-summary-field recipient-address-summary-field">
                  <span>주소</span>
                  <div className="recipient-address-input-row">
                    <input
                      data-testid="recipient-postal-code-input"
                      aria-label="우편번호"
                      inputMode="numeric"
                      value={recipientForm.postal_code}
                      onChange={(event) => setRecipientForm((current) => ({ ...current, postal_code: event.target.value }))}
                    />
                    <input
                      data-testid="recipient-address-input"
                      aria-label="앞주소"
                      value={recipientForm.address}
                      onChange={(event) => setRecipientForm((current) => ({ ...current, address: event.target.value }))}
                    />
                    <input
                      data-testid="recipient-address-detail-input"
                      aria-label="뒷주소"
                      value={recipientForm.address_detail}
                      onChange={(event) => setRecipientForm((current) => ({ ...current, address_detail: event.target.value }))}
                    />
                  </div>
                </div>
                {createError ? (
                  <div className="recipient-inline-error" role="alert">
                    {createError}
                  </div>
                ) : null}
                {createMessage ? <div className="recipient-inline-note">{createMessage}</div> : null}
              </form>
            ) : (
              <div className="recipient-detail-summary">
                <div className="recipient-summary-item">
                  <span>이름</span>
                  <strong>{detailViewRecipient?.name ?? '없음'}</strong>
                </div>
                <div className="recipient-summary-item">
                  <span>생년월일</span>
                  <strong>{detailViewRecipient?.birth_date ?? '없음'}</strong>
                </div>
                <div className="recipient-summary-item">
                  <span>만 나이</span>
                  <strong data-testid="recipient-detail-international-age">
                    {formatInternationalAge(detailViewRecipient?.birth_date ?? '')}
                  </strong>
                </div>
                <div className="recipient-summary-item">
                  <span>성별</span>
                  <strong>{detailViewRecipient?.sex_code ?? '없음'}</strong>
                </div>
                <div className="recipient-summary-item">
                  <span>등급</span>
                  <strong data-testid="recipient-detail-grade">
                    {formatGradeCode(detailListProjection?.grade_code)}
                  </strong>
                </div>
                <div className="recipient-summary-item">
                  <span>인정번호</span>
                  <strong data-testid="recipient-detail-certification-number">미지정</strong>
                </div>
                <div className="recipient-summary-item">
                  <span>휴대전화</span>
                  <strong data-testid="recipient-detail-mobile-phone">
                    {formatNullable(detailViewRecipient?.mobile_phone)}
                  </strong>
                </div>
                <div className="recipient-summary-item">
                  <span>본인부담금</span>
                  <strong data-testid="recipient-detail-copay">
                    {formatCopaymentRate(detailListProjection?.copayment_rate)}
                  </strong>
                </div>
                <div className="recipient-summary-item recipient-summary-item-address">
                  <span>주소</span>
                  <div className="recipient-address-inline" data-testid="recipient-detail-address">
                    <span data-testid="recipient-detail-postal-code">
                      {formatNullable(detailViewRecipient?.postal_code)}
                    </span>
                    <span data-testid="recipient-detail-address-main">
                      {formatNullable(detailViewRecipient?.address)}
                    </span>
                    <span data-testid="recipient-detail-address-detail">
                      없음
                    </span>
                  </div>
                </div>
              </div>
            )}
          </section>
          <span className="visually-hidden" data-testid="recipient-detail-home-phone">
            {formatNullable(detailViewRecipient?.home_phone)}
          </span>

          {detailStaleConflict ? (
            <div className="recipient-stale-panel">
              {detailError ? (
                <div
                  className="recipient-inline-error"
                  role="alert"
                  data-testid="recipient-stale-conflict-message"
                >
                  {detailError}
                </div>
              ) : null}
              <div data-testid="recipient-stale-latest-value">
                최신 서버값: {detailStaleConflict.latest.name}
              </div>
              {detailStaleConflict.sameFieldConflicts.length > 0 ? (
                <div
                  className="recipient-stale-diff"
                  data-testid="recipient-same-field-conflict-log"
                >
                  {detailStaleConflict.sameFieldConflicts.map((entry) => (
                    <div
                      key={entry.field}
                      data-testid={`recipient-conflict-field-${entry.field}`}
                    >
                      {entry.label}({entry.field}): 사용자 {entry.userValue} / 서버{' '}
                      {entry.serverValue}
                    </div>
                  ))}
                </div>
              ) : (
                <div className="recipient-stale-diff" data-testid="recipient-stale-diff">
                  사용자 입력: {detailStaleConflict.draftAtConflict.name || '없음'} / 최신
                  서버값: {detailStaleConflict.latest.name}
                </div>
              )}
              {detailStaleConflict.canAutoReapply ? (
                <button
                  className="recipient-secondary-button"
                  data-testid="recipient-stale-reapply"
                  type="button"
                  onClick={() => void handleDetailReapply()}
                  disabled={detailSaving || detailLoading}
                >
                  최신 버전에 변경 내용 다시 적용
                </button>
              ) : null}
            </div>
          ) : null}

          {detailFormReady ? (
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
                    disabled={detailSaving}
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
                    disabled={detailSaving}
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
                    disabled={detailSaving}
                  >
                    <option value="MALE">남성</option>
                    <option value="FEMALE">여성</option>
                  </select>
                </label>
                <label className="recipient-field">
                  상태
                  <select
                    data-testid="recipient-detail-status-select"
                    value={detailForm.recipient_status}
                    onChange={(event) =>
                      setDetailForm((current) => ({
                        ...current,
                        recipient_status: event.target.value as RecipientStatus,
                      }))
                    }
                    required
                    disabled={detailSaving}
                  >
                    <option value="ACTIVE">이용중</option>
                    <option value="ENDED">계약종료</option>
                    <option value="WAITING">대기중</option>
                  </select>
                </label>
                <label className="recipient-field">
                  우편번호
                  <input
                    value={detailForm.postal_code}
                    onChange={(event) => setDetailForm((current) => ({ ...current, postal_code: event.target.value }))}
                    disabled={detailSaving}
                  />
                </label>
                <label className="recipient-field recipient-field-wide">
                  주소
                  <input
                    value={detailForm.address}
                    onChange={(event) => setDetailForm((current) => ({ ...current, address: event.target.value }))}
                    disabled={detailSaving}
                  />
                </label>
                <label className="recipient-field">
                  자택 전화
                  <input
                    value={detailForm.home_phone}
                    onChange={(event) => setDetailForm((current) => ({ ...current, home_phone: event.target.value }))}
                    disabled={detailSaving}
                  />
                </label>
                <label className="recipient-field">
                  휴대전화
                  <input
                    value={detailForm.mobile_phone}
                    onChange={(event) => setDetailForm((current) => ({ ...current, mobile_phone: event.target.value }))}
                    disabled={detailSaving}
                  />
                </label>
                <label className="recipient-field recipient-field-wide">
                  출처 메모
                  <textarea
                    value={detailForm.memo}
                    onChange={(event) => setDetailForm((current) => ({ ...current, memo: event.target.value }))}
                    disabled={detailSaving}
                  />
                </label>
              </div>
              {detailMessage ? <div className="recipient-inline-note">{detailMessage}</div> : null}
              <div className="recipient-form-actions">
                <button
                  className="recipient-primary-button"
                  type="submit"
                  data-testid="recipient-detail-save"
                  disabled={!detailSaveEnabled}
                >
                  {detailSaving ? '저장 중…' : '기본정보 저장'}
                </button>
              </div>
            </form>
          ) : null}

          <div className="recipient-detail-columns recipient-guardian-cards">
            {([0, 1] as GuardianSlot[]).map((guardianIndex) => {
              const form = guardianForms[guardianIndex];
              return (
                <div className="recipient-guardian-card" key={guardianIndex}>
                  <div className="recipient-guardian-card-heading">
                    <h3 className="recipient-guardian-card-title">보호자{guardianIndex + 1} 정보</h3>
                    <div className="recipient-guardian-card-actions">
                      <button
                        className="recipient-secondary-button recipient-guardian-save-button"
                        data-testid={`guardian-${guardianIndex + 1}-save-button`}
                        form={`guardian-${guardianIndex + 1}-form`}
                        type={guardianEditOpen[guardianIndex] ? 'submit' : 'button'}
                        aria-expanded={guardianEditOpen[guardianIndex]}
                        onClick={
                          guardianEditOpen[guardianIndex]
                            ? undefined
                            : () => {
                                setGuardianEditSnapshots((current) => {
                                  const next: GuardianFormSlots = [current[0], current[1]];
                                  next[guardianIndex] = guardianForms[guardianIndex];
                                  return next;
                                });
                                setGuardianEditOpen((current) => {
                                  const next: [boolean, boolean] = [current[0], current[1]];
                                  next[guardianIndex] = true;
                                  return next;
                                });
                              }
                        }
                        disabled={!activeId || guardianSaving}
                      >
                        {guardianEditOpen[guardianIndex] ? '저장' : '보호자 등록'}
                      </button>
                      {guardianEditOpen[guardianIndex] ? (
                        <button
                          className="recipient-secondary-button recipient-guardian-cancel-button"
                          data-testid={`guardian-${guardianIndex + 1}-cancel-button`}
                          type="button"
                          onClick={() => {
                            setGuardianForms((current) => {
                              const next: GuardianFormSlots = [current[0], current[1]];
                              next[guardianIndex] = guardianEditSnapshots[guardianIndex];
                              return next;
                            });
                            setGuardianEditOpen((current) => {
                              const next: [boolean, boolean] = [current[0], current[1]];
                              next[guardianIndex] = false;
                              return next;
                            });
                            setGuardianError(null);
                            setGuardianMessage(null);
                          }}
                          disabled={guardianSaving}
                        >
                          취소
                        </button>
                      ) : null}
                    </div>
                  </div>
                  <section
                    className={`recipient-subsection recipient-guardian-section${guardianEditOpen[guardianIndex] ? ' is-editing' : ''}`}
                    data-testid={`recipient-guardian-${guardianIndex + 1}-section`}
                  >
                    <form
                      id={`guardian-${guardianIndex + 1}-form`}
                      className="recipient-subform recipient-guardian-form"
                      noValidate
                      onSubmit={(event) => void handleGuardianSubmit(event, guardianIndex)}
                    >
                      <label className="recipient-field">
                        이름
                        <input
                          data-testid={`guardian-${guardianIndex + 1}-name-input`}
                          value={form.name}
                          onChange={(event) =>
                            setGuardianForms((current) => {
                              const next: GuardianFormSlots = [current[0], current[1]];
                              next[guardianIndex] = { ...next[guardianIndex], name: event.target.value };
                              return next;
                            })
                          }
                          disabled={!activeId || !guardianEditOpen[guardianIndex]}
                        />
                      </label>
                      <label className="recipient-field">
                        관계
                        <input
                          data-testid={`guardian-${guardianIndex + 1}-relationship-input`}
                          value={form.relationship_text}
                          onChange={(event) =>
                            setGuardianForms((current) => {
                              const next: GuardianFormSlots = [current[0], current[1]];
                              next[guardianIndex] = { ...next[guardianIndex], relationship_text: event.target.value };
                              return next;
                            })
                          }
                          disabled={!activeId || !guardianEditOpen[guardianIndex]}
                        />
                      </label>
                      <label className="recipient-field">
                        전화번호
                        <input
                          data-testid={`guardian-${guardianIndex + 1}-phone-input`}
                          value={form.phone}
                          onChange={(event) =>
                            setGuardianForms((current) => {
                              const next: GuardianFormSlots = [current[0], current[1]];
                              next[guardianIndex] = { ...next[guardianIndex], phone: event.target.value };
                              return next;
                            })
                          }
                          disabled={!activeId || !guardianEditOpen[guardianIndex]}
                        />
                      </label>
                      <label className="recipient-field">
                        이메일
                        <input
                          data-testid={`guardian-${guardianIndex + 1}-email-input`}
                          type="email"
                          value={form.email}
                          onChange={(event) =>
                            setGuardianForms((current) => {
                              const next: GuardianFormSlots = [current[0], current[1]];
                              next[guardianIndex] = { ...next[guardianIndex], email: event.target.value };
                              return next;
                            })
                          }
                          disabled={!activeId || !guardianEditOpen[guardianIndex]}
                        />
                      </label>
                      <label className="recipient-field recipient-field-wide recipient-address-summary-field">
                        주소
                        <div className="recipient-address-input-row">
                          <input
                            data-testid={`guardian-${guardianIndex + 1}-postal-code-input`}
                            aria-label="우편번호"
                            inputMode="numeric"
                            value={form.postal_code}
                            onChange={(event) =>
                              setGuardianForms((current) => {
                                const next: GuardianFormSlots = [current[0], current[1]];
                                next[guardianIndex] = { ...next[guardianIndex], postal_code: event.target.value };
                                return next;
                              })
                            }
                            disabled={!activeId || !guardianEditOpen[guardianIndex]}
                          />
                          <input
                            data-testid={`guardian-${guardianIndex + 1}-address-input`}
                            aria-label="앞주소"
                            value={form.address}
                            onChange={(event) =>
                              setGuardianForms((current) => {
                                const next: GuardianFormSlots = [current[0], current[1]];
                                next[guardianIndex] = { ...next[guardianIndex], address: event.target.value };
                                return next;
                              })
                            }
                            disabled={!activeId || !guardianEditOpen[guardianIndex]}
                          />
                          <input
                            data-testid={`guardian-${guardianIndex + 1}-address-detail-input`}
                            aria-label="뒷주소"
                            value={form.address_detail}
                            onChange={(event) =>
                              setGuardianForms((current) => {
                                const next: GuardianFormSlots = [current[0], current[1]];
                                next[guardianIndex] = { ...next[guardianIndex], address_detail: event.target.value };
                                return next;
                              })
                            }
                            disabled={!activeId || !guardianEditOpen[guardianIndex]}
                          />
                        </div>
                      </label>
                      {guardianError ? <div className="recipient-inline-error">{guardianError}</div> : null}
                      {guardianMessage ? <div className="recipient-inline-note">{guardianMessage}</div> : null}
                    </form>
                  </section>
                </div>
              );
            })}

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

            </>
          ) : null}

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
          {detailExtrasOpen ? (
            <div className="recipient-detail-extra-sections" data-testid="recipient-detail-extra-sections">
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
            </div>
          ) : null}
        </section>
      </div>
    </div>
  );
};

export default RecipientsPage;

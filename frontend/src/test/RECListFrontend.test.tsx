import './setup';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import RecipientsPage from '../pages/RecipientsPage';
import { listRecipients } from '../services/recipientApi';
import type { RecipientListItem, RecipientListResponse } from '../services/recipientApi';

const recipientsCssPath = resolve(dirname(fileURLToPath(import.meta.url)), '../styles/recipients.css');

type ListQuery = {
  search: string | null;
  status: string | null;
  page: string | null;
  page_size: string | null;
};

const originalFetch = globalThis.fetch;

function listItem(overrides: Partial<RecipientListItem> = {}): RecipientListItem {
  return {
    id: 1,
    name: '김수급',
    birth_date: '1950-03-15',
    sex_code: 'FEMALE',
    recipient_no: 'R-001',
    postal_code: '06236',
    address: '서울시 강남구',
    home_phone: '02-111-2222',
    mobile_phone: '010-1111-2222',
    memo: null,
    row_version: 1,
    grade_code: '3',
    benefit_code: 'BASIC',
    copayment_rate: 15,
    services: [
      {
        service_group_code: 'VISIT',
        display_name: '방문요양',
        service_types: [
          { service_type_code: 'V1', display_name: '일반방문' },
          { service_type_code: 'V2', display_name: '야간방문' },
        ],
      },
      {
        service_group_code: 'BATH',
        display_name: '방문목욕',
        service_types: [{ service_type_code: 'B1', display_name: '차량목욕' }],
      },
    ],
    ...overrides,
  };
}

function listResponse(
  items: RecipientListItem[],
  total = items.length,
  page = 1,
  pageSize = 100,
): RecipientListResponse {
  return { items, total, page, page_size: pageSize };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function parseListQuery(url: URL): ListQuery {
  return {
    search: url.searchParams.get('search'),
    status: url.searchParams.get('status'),
    page: url.searchParams.get('page'),
    page_size: url.searchParams.get('page_size'),
  };
}

/** Exact recipient name via row strong text (avoids accessible-name clashes e.g. 이용중행 vs 이용중행2). */
function hasRecipientRowWithExactName(name: string): boolean {
  return screen
    .queryAllByTestId('recipient-name-option')
    .some((row) => row.querySelector('strong')?.textContent === name);
}

function installRecipientListFetch(
  resolveList: (query: ListQuery) => RecipientListResponse,
): { requests: ListQuery[] } {
  const requests: ListQuery[] = [];

  globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const rawUrl =
      typeof input === 'string' ? input : input instanceof Request ? input.url : input.toString();
    const url = new URL(rawUrl, 'http://localhost');
    const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();

    if (url.pathname === '/api/v1/recipients' && method === 'GET') {
      const query = parseListQuery(url);
      requests.push(query);
      return jsonResponse(resolveList(query));
    }

    if (url.pathname.startsWith('/api/v1/recipients/') && method === 'GET') {
      const id = Number(url.pathname.split('/').pop());
      const item = listItem({ id: Number.isFinite(id) ? id : 1 });
      if (url.pathname.endsWith('/guardians')) return jsonResponse({ items: [] });
      if (url.pathname.endsWith('/primary-guardian-periods')) return jsonResponse({ items: [] });
      if (url.pathname.endsWith('/payer-snapshots')) return jsonResponse({ items: [] });
      if (url.pathname.endsWith('/plan-notifications')) return jsonResponse({ items: [] });
      return jsonResponse({
        id: item.id,
        name: item.name,
        birth_date: item.birth_date,
        sex_code: item.sex_code,
        recipient_status: 'ACTIVE' as const,
        recipient_no: item.recipient_no,
        postal_code: item.postal_code,
        address: item.address,
        home_phone: item.home_phone,
        mobile_phone: item.mobile_phone,
        memo: item.memo,
        row_version: item.row_version,
      });
    }

    return jsonResponse({ detail: { code: 'not_found' } }, 404);
  }) as typeof globalThis.fetch;

  return { requests };
}

/** Fire scroll near the bottom of the list panel (not window). */
function scrollListNearBottom() {
  const scroller = screen.getByTestId('recipient-list-scroll');
  Object.defineProperty(scroller, 'scrollHeight', { configurable: true, value: 1000 });
  Object.defineProperty(scroller, 'clientHeight', { configurable: true, value: 200 });
  Object.defineProperty(scroller, 'scrollTop', {
    configurable: true,
    writable: true,
    value: 750,
  });
  fireEvent.scroll(scroller);
}

describe('REC-LIST frontend contract', () => {
  beforeEach(() => {
    window.history.replaceState({}, '', '/recipients');
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
    window.history.replaceState({}, '', '/');
  });

  test('listRecipients sends search/status/page/page_size as GET query params', async () => {
    const { requests } = installRecipientListFetch(() => listResponse([]));

    await listRecipients({
      search: ' 김수급 ',
      status: 'WAITING',
      page: 2,
      pageSize: 25,
    });

    expect(requests).toHaveLength(1);
    expect(requests[0]).toEqual({
      search: '김수급',
      status: 'WAITING',
      page: '2',
      page_size: '25',
    });
  });

  test('filter order is ACTIVE/ALL/ENDED/WAITING; default URL and request are ACTIVE', async () => {
    const { requests } = installRecipientListFetch(() =>
      listResponse([listItem({ id: 10, name: '필터대상' })]),
    );

    render(<RecipientsPage />);

    await waitFor(() => expect(requests.length).toBeGreaterThan(0));
    // First screen explicitly uses status=ACTIVE (API helper may omit; page always sends ACTIVE default).
    expect(requests[0].status).toBe('ACTIVE');
    await waitFor(() => expect(window.location.search).toMatch(/status=ACTIVE/));

    const select = screen.getByTestId('recipient-filter-select');
    const options = within(select).getAllByRole('option').map((node) => node.textContent);
    expect(options).toEqual(['이용중', '전체', '계약종료', '대기중']);
    expect(within(select).getAllByRole('option').map((node) => (node as HTMLOptionElement).value)).toEqual([
      'ACTIVE',
      'ALL',
      'ENDED',
      'WAITING',
    ]);

    fireEvent.change(select, { target: { value: 'ALL' } });
    await waitFor(() => expect(requests.at(-1)?.status).toBe('ALL'));

    fireEvent.change(select, { target: { value: 'ENDED' } });
    await waitFor(() => expect(requests.at(-1)?.status).toBe('ENDED'));

    fireEvent.change(select, { target: { value: 'WAITING' } });
    await waitFor(() => expect(requests.at(-1)?.status).toBe('WAITING'));

    fireEvent.change(select, { target: { value: 'ACTIVE' } });
    await waitFor(() => expect(requests.at(-1)?.status).toBe('ACTIVE'));

    expect(requests.every((request) => request.status !== 'HISTORY')).toBe(true);
  });

  test('listRecipients omits status when not provided so API default remains ALL', async () => {
    const { requests } = installRecipientListFetch(() => listResponse([]));
    await listRecipients({ search: 'x', page: 1, pageSize: 10 });
    expect(requests).toHaveLength(1);
    expect(requests[0].status).toBeNull();
  });

  test('list rows do not display 이용중/계약종료/대기중 status text', async () => {
    installRecipientListFetch(() =>
      listResponse([listItem({ id: 10, name: '상태미표시' })]),
    );
    render(<RecipientsPage />);
    const row = await screen.findByRole('button', { name: /상태미표시/ });
    expect(row.textContent).not.toMatch(/이용중|계약종료|대기중/);
    expect(within(row).queryByText('이용중')).toBeNull();
    expect(within(row).queryByText('계약종료')).toBeNull();
    expect(within(row).queryByText('대기중')).toBeNull();
  });

  test('detail status select saves recipient_status through PATCH and shows success/error', async () => {
    const patchBodies: unknown[] = [];
    let detailStatus: 'ACTIVE' | 'WAITING' | 'ENDED' = 'ACTIVE';
    let detailRowVersion = 1;
    let forcePatchError = false;

    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const rawUrl =
        typeof input === 'string' ? input : input instanceof Request ? input.url : input.toString();
      const url = new URL(rawUrl, 'http://localhost');
      const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();

      if (url.pathname === '/api/v1/recipients' && method === 'GET') {
        return jsonResponse(listResponse([listItem({ id: 21, name: '상태저장' })]));
      }
      if (/^\/api\/v1\/recipients\/\d+$/.test(url.pathname) && method === 'PATCH') {
        const body = JSON.parse(String(init?.body ?? '{}'));
        patchBodies.push(body);
        if (forcePatchError) {
          return jsonResponse(
            {
              error: { code: 'VALIDATION_ERROR', message: '상태 오류' },
              field_errors: [],
              details: {},
              request_id: 't-status-err',
            },
            422,
          );
        }
        if (body.recipient_status === 'WAITING' || body.recipient_status === 'ENDED' || body.recipient_status === 'ACTIVE') {
          detailStatus = body.recipient_status;
          detailRowVersion = Number(body.expected_row_version) + 1;
          return jsonResponse({
            id: 21,
            name: '상태저장',
            birth_date: '1950-03-15',
            sex_code: 'FEMALE',
            recipient_status: detailStatus,
            recipient_no: 'R-001',
            postal_code: '06236',
            address: '서울시 강남구',
            home_phone: '02-111-2222',
            mobile_phone: '010-1111-2222',
            memo: null,
            row_version: detailRowVersion,
          });
        }
        return jsonResponse(
          {
            error: { code: 'VALIDATION_ERROR', message: '상태 오류' },
            field_errors: [],
            details: {},
            request_id: 't',
          },
          422,
        );
      }
      if (url.pathname.startsWith('/api/v1/recipients/') && method === 'GET') {
        if (url.pathname.endsWith('/guardians')) return jsonResponse({ items: [] });
        if (url.pathname.endsWith('/primary-guardian-periods')) return jsonResponse({ items: [] });
        if (url.pathname.endsWith('/payer-snapshots')) return jsonResponse({ items: [] });
        if (url.pathname.endsWith('/plan-notifications')) return jsonResponse({ items: [] });
        return jsonResponse({
          id: 21,
          name: '상태저장',
          birth_date: '1950-03-15',
          sex_code: 'FEMALE',
          recipient_status: detailStatus,
          recipient_no: 'R-001',
          postal_code: '06236',
          address: '서울시 강남구',
          home_phone: '02-111-2222',
          mobile_phone: '010-1111-2222',
          memo: null,
          row_version: detailRowVersion,
        });
      }
      return jsonResponse({ detail: { code: 'not_found' } }, 404);
    }) as typeof globalThis.fetch;

    render(<RecipientsPage />);
    fireEvent.click(await screen.findByRole('button', { name: /상태저장/ }));

    const statusSelect = await screen.findByTestId('recipient-detail-status-select');
    expect(statusSelect).toHaveValue('ACTIVE');
    expect(within(statusSelect).getAllByRole('option').map((n) => n.textContent)).toEqual([
      '이용중',
      '계약종료',
      '대기중',
    ]);

    fireEvent.change(statusSelect, { target: { value: 'WAITING' } });
    fireEvent.click(await screen.findByRole('button', { name: '기본정보 저장' }));

    await waitFor(() => expect(patchBodies.length).toBeGreaterThan(0));
    expect(patchBodies[0]).toEqual(
      expect.objectContaining({
        recipient_status: 'WAITING',
        expected_row_version: 1,
      }),
    );
    await waitFor(() =>
      expect(screen.getByText('수급자 정보를 저장했습니다.')).toBeInTheDocument(),
    );
    expect(statusSelect).toHaveValue('WAITING');

    // Error path must execute: force 422 and assert role=alert error (draft preserved).
    forcePatchError = true;
    fireEvent.change(statusSelect, { target: { value: 'ENDED' } });
    expect(statusSelect).toHaveValue('ENDED');
    fireEvent.click(await screen.findByRole('button', { name: '기본정보 저장' }));
    const errorAlert = await screen.findByRole('alert');
    expect(errorAlert).toHaveClass('recipient-inline-error');
    expect(errorAlert.textContent).toMatch(/상태 오류|저장하지 못했습니다/);
    // User draft status remains ENDED after failed save.
    expect(statusSelect).toHaveValue('ENDED');

    // Create form has no status selector.
    fireEvent.click(screen.getByTestId('recipient-create-toggle'));
    expect(document.querySelector('#recipient-create-form [data-testid="recipient-detail-status-select"]')).toBeNull();
    expect(document.querySelector('#recipient-create-form select[name="recipient_status"]')).toBeNull();
  });

  test('delayed detail GET: status/save not usable until GET resolves with real server tag', async () => {
    type PendingDetail = { resolve: (response: Response) => void };
    const pendingDetail: PendingDetail[] = [];
    const patchBodies: unknown[] = [];

    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const rawUrl =
        typeof input === 'string' ? input : input instanceof Request ? input.url : input.toString();
      const url = new URL(rawUrl, 'http://localhost');
      const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();

      if (url.pathname === '/api/v1/recipients' && method === 'GET') {
        return jsonResponse(listResponse([listItem({ id: 41, name: '지연상세' })]));
      }
      if (/^\/api\/v1\/recipients\/\d+$/.test(url.pathname) && method === 'PATCH') {
        const body = JSON.parse(String(init?.body ?? '{}'));
        patchBodies.push(body);
        return jsonResponse({
          id: 41,
          name: '지연상세',
          birth_date: '1950-03-15',
          sex_code: 'FEMALE',
          recipient_status: body.recipient_status ?? 'ENDED',
          recipient_no: 'R-041',
          postal_code: null,
          address: null,
          home_phone: null,
          mobile_phone: '010-1111-2222',
          memo: null,
          row_version: Number(body.expected_row_version ?? 1) + 1,
        });
      }
      if (url.pathname.startsWith('/api/v1/recipients/') && method === 'GET') {
        if (url.pathname.endsWith('/guardians')) return jsonResponse({ items: [] });
        if (url.pathname.endsWith('/primary-guardian-periods')) return jsonResponse({ items: [] });
        if (url.pathname.endsWith('/payer-snapshots')) return jsonResponse({ items: [] });
        if (url.pathname.endsWith('/plan-notifications')) return jsonResponse({ items: [] });
        // Primary detail GET is deferred (not related collection GETs).
        if (/^\/api\/v1\/recipients\/\d+$/.test(url.pathname)) {
          return new Promise<Response>((resolve) => {
            pendingDetail.push({ resolve });
          });
        }
      }
      return jsonResponse({ detail: { code: 'not_found' } }, 404);
    }) as typeof globalThis.fetch;

    render(<RecipientsPage />);
    fireEvent.click(await screen.findByRole('button', { name: /지연상세/ }));

    // While detail GET is pending: loading note, no editable status/save (list cannot invent ACTIVE).
    await waitFor(() => {
      expect(screen.getByText('상세 정보를 불러오는 중입니다.')).toBeInTheDocument();
    });
    expect(screen.queryByTestId('recipient-detail-status-select')).toBeNull();
    expect(screen.queryByTestId('recipient-detail-save')).toBeNull();
    expect(screen.queryByRole('button', { name: '기본정보 저장' })).toBeNull();
    expect(patchBodies).toHaveLength(0);

    expect(pendingDetail.length).toBeGreaterThan(0);
    pendingDetail[pendingDetail.length - 1].resolve(
      jsonResponse({
        id: 41,
        name: '지연상세',
        birth_date: '1950-03-15',
        sex_code: 'FEMALE',
        recipient_status: 'ENDED',
        recipient_no: 'R-041',
        postal_code: null,
        address: null,
        home_phone: null,
        mobile_phone: '010-1111-2222',
        memo: null,
        row_version: 7,
      }),
    );

    const statusSelect = await screen.findByTestId('recipient-detail-status-select');
    expect(statusSelect).toHaveValue('ENDED');
    const saveButton = screen.getByRole('button', { name: '기본정보 저장' });
    // no-op: successful detail GET with no user edits → Save stays disabled (baseline === draft).
    expect(saveButton).toBeDisabled();

    fireEvent.change(statusSelect, { target: { value: 'WAITING' } });
    expect(saveButton).not.toBeDisabled();
    fireEvent.click(saveButton);
    await waitFor(() => expect(patchBodies.length).toBe(1));
    expect(patchBodies[0]).toEqual(
      expect.objectContaining({
        recipient_status: 'WAITING',
        expected_row_version: 7,
      }),
    );
  });

  test('rejected detail GET: visible error and zero PATCH (no ACTIVE overwrite from list)', async () => {
    const patchBodies: unknown[] = [];

    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const rawUrl =
        typeof input === 'string' ? input : input instanceof Request ? input.url : input.toString();
      const url = new URL(rawUrl, 'http://localhost');
      const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();

      if (url.pathname === '/api/v1/recipients' && method === 'GET') {
        return jsonResponse(listResponse([listItem({ id: 42, name: '실패상세' })]));
      }
      if (/^\/api\/v1\/recipients\/\d+$/.test(url.pathname) && method === 'PATCH') {
        patchBodies.push(JSON.parse(String(init?.body ?? '{}')));
        return jsonResponse({ detail: { code: 'should_not_patch' } }, 500);
      }
      if (url.pathname.startsWith('/api/v1/recipients/') && method === 'GET') {
        if (url.pathname.endsWith('/guardians')) return jsonResponse({ items: [] });
        if (url.pathname.endsWith('/primary-guardian-periods')) return jsonResponse({ items: [] });
        if (url.pathname.endsWith('/payer-snapshots')) return jsonResponse({ items: [] });
        if (url.pathname.endsWith('/plan-notifications')) return jsonResponse({ items: [] });
        if (/^\/api\/v1\/recipients\/\d+$/.test(url.pathname)) {
          return jsonResponse(
            {
              error: { code: 'RECIPIENT_NOT_FOUND', message: '수급자를 찾을 수 없습니다.' },
              field_errors: [],
              details: {},
              request_id: 't-detail-fail',
            },
            404,
          );
        }
      }
      return jsonResponse({ detail: { code: 'not_found' } }, 404);
    }) as typeof globalThis.fetch;

    render(<RecipientsPage />);
    fireEvent.click(await screen.findByRole('button', { name: /실패상세/ }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveClass('recipient-inline-error');
    expect(alert.textContent).toBeTruthy();
    expect(screen.queryByTestId('recipient-detail-status-select')).toBeNull();
    expect(screen.queryByRole('button', { name: '기본정보 저장' })).toBeNull();
    expect(patchBodies).toHaveLength(0);
  });

  test('ROW_VERSION_CONFLICT reloads latest detail, preserves draft, reapplies with latest row_version', async () => {
    // Different-field conflict: user changes status only; concurrent server changes name only.
    const patchBodies: Array<Record<string, unknown>> = [];
    let detailGets = 0;
    let serverRowVersion = 1;
    let serverName = '충돌원본';
    let serverStatus: 'ACTIVE' | 'ENDED' | 'WAITING' = 'ACTIVE';

    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const rawUrl =
        typeof input === 'string' ? input : input instanceof Request ? input.url : input.toString();
      const url = new URL(rawUrl, 'http://localhost');
      const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();

      if (url.pathname === '/api/v1/recipients' && method === 'GET') {
        return jsonResponse(
          listResponse([listItem({ id: 31, name: serverName, row_version: serverRowVersion })]),
        );
      }
      if (/^\/api\/v1\/recipients\/\d+$/.test(url.pathname) && method === 'PATCH') {
        const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
        patchBodies.push(body);
        if (Number(body.expected_row_version) !== serverRowVersion) {
          return jsonResponse(
            {
              error: {
                code: 'ROW_VERSION_CONFLICT',
                message: '다른 사용자가 먼저 변경했습니다. 최신 정보를 다시 불러오세요.',
              },
              field_errors: [],
              details: { current_row_version: serverRowVersion },
              request_id: 't-conflict',
            },
            409,
          );
        }
        if (typeof body.name === 'string') serverName = body.name;
        if (typeof body.recipient_status === 'string') {
          serverStatus = body.recipient_status as 'ACTIVE' | 'ENDED' | 'WAITING';
        }
        serverRowVersion = Number(body.expected_row_version) + 1;
        return jsonResponse({
          id: 31,
          name: serverName,
          birth_date: '1950-03-15',
          sex_code: 'FEMALE',
          recipient_status: serverStatus,
          recipient_no: 'R-031',
          postal_code: null,
          address: null,
          home_phone: null,
          mobile_phone: '010-1111-2222',
          memo: null,
          row_version: serverRowVersion,
        });
      }
      if (url.pathname.startsWith('/api/v1/recipients/') && method === 'GET') {
        if (url.pathname.endsWith('/guardians')) return jsonResponse({ items: [] });
        if (url.pathname.endsWith('/primary-guardian-periods')) return jsonResponse({ items: [] });
        if (url.pathname.endsWith('/payer-snapshots')) return jsonResponse({ items: [] });
        if (url.pathname.endsWith('/plan-notifications')) return jsonResponse({ items: [] });
        detailGets += 1;
        return jsonResponse({
          id: 31,
          name: serverName,
          birth_date: '1950-03-15',
          sex_code: 'FEMALE',
          recipient_status: serverStatus,
          recipient_no: 'R-031',
          postal_code: null,
          address: null,
          home_phone: null,
          mobile_phone: '010-1111-2222',
          memo: null,
          row_version: serverRowVersion,
        });
      }
      return jsonResponse({ detail: { code: 'not_found' } }, 404);
    }) as typeof globalThis.fetch;

    render(<RecipientsPage />);
    fireEvent.click(await screen.findByRole('button', { name: /충돌원본/ }));
    await waitFor(() => expect(screen.getByTestId('recipient-detail-name-input')).toHaveValue('충돌원본'));

    // Concurrent server changes name only (different field from user's status edit).
    serverRowVersion = 5;
    serverName = '서버최신이름';

    fireEvent.change(screen.getByTestId('recipient-detail-status-select'), {
      target: { value: 'WAITING' },
    });
    fireEvent.click(await screen.findByRole('button', { name: '기본정보 저장' }));

    const conflictAlerts = await screen.findAllByRole('alert');
    expect(conflictAlerts).toHaveLength(1);
    expect(conflictAlerts[0].textContent).toBe(
      '다른 사용자가 먼저 변경했습니다. 최신 서버값을 확인하고 필요한 변경만 다시 적용해주세요.',
    );
    await waitFor(() => expect(screen.getByTestId('recipient-stale-latest-value')).toHaveTextContent('서버최신이름'));
    // User status draft preserved; server name shown on reapply panel (outside alert).
    expect(screen.getByTestId('recipient-detail-status-select')).toHaveValue('WAITING');
    expect(screen.getByTestId('recipient-detail-name-input')).toHaveValue('서버최신이름');
    expect(detailGets).toBeGreaterThan(1);

    // Post-conflict re-edit: change status again before reapply; PATCH must carry new value.
    fireEvent.change(screen.getByTestId('recipient-detail-status-select'), {
      target: { value: 'ENDED' },
    });
    fireEvent.click(screen.getByTestId('recipient-stale-reapply'));
    await waitFor(() =>
      expect(patchBodies.some((body) => body.expected_row_version === 5)).toBe(true),
    );
    const reapplyBody = patchBodies.find((body) => body.expected_row_version === 5);
    expect(reapplyBody).toEqual({
      expected_row_version: 5,
      recipient_status: 'ENDED',
    });
    expect(reapplyBody).not.toHaveProperty('name');
    await waitFor(() =>
      expect(screen.getByText('최신 버전에 변경 내용을 다시 적용했습니다.')).toBeInTheDocument(),
    );
    expect(screen.queryByTestId('recipient-stale-reapply')).toBeNull();
  });

  test('ROW_VERSION_CONFLICT reapply omits untouched recipient_status so concurrent ENDED is preserved', async () => {
    // User edits only name; concurrent server sets status ENDED only (different field).
    const patchBodies: Array<Record<string, unknown>> = [];
    let serverRowVersion = 1;
    let serverName = '상태충돌원본';
    let serverStatus: 'ACTIVE' | 'ENDED' | 'WAITING' = 'ACTIVE';

    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const rawUrl =
        typeof input === 'string' ? input : input instanceof Request ? input.url : input.toString();
      const url = new URL(rawUrl, 'http://localhost');
      const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();

      if (url.pathname === '/api/v1/recipients' && method === 'GET') {
        return jsonResponse(
          listResponse([listItem({ id: 32, name: serverName, row_version: serverRowVersion })]),
        );
      }
      if (/^\/api\/v1\/recipients\/\d+$/.test(url.pathname) && method === 'PATCH') {
        const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
        patchBodies.push(body);
        if (Number(body.expected_row_version) !== serverRowVersion) {
          return jsonResponse(
            {
              error: {
                code: 'ROW_VERSION_CONFLICT',
                message: '다른 사용자가 먼저 변경했습니다. 최신 정보를 다시 불러오세요.',
              },
              field_errors: [],
              details: { current_row_version: serverRowVersion },
              request_id: 't-conflict-status-preserve',
            },
            409,
          );
        }
        if (typeof body.name === 'string') serverName = body.name;
        if (typeof body.recipient_status === 'string') {
          serverStatus = body.recipient_status as 'ACTIVE' | 'ENDED' | 'WAITING';
        }
        serverRowVersion = Number(body.expected_row_version) + 1;
        return jsonResponse({
          id: 32,
          name: serverName,
          birth_date: '1950-03-15',
          sex_code: 'FEMALE',
          recipient_status: serverStatus,
          recipient_no: 'R-032',
          postal_code: null,
          address: null,
          home_phone: null,
          mobile_phone: '010-1111-2222',
          memo: null,
          row_version: serverRowVersion,
        });
      }
      if (url.pathname.startsWith('/api/v1/recipients/') && method === 'GET') {
        if (url.pathname.endsWith('/guardians')) return jsonResponse({ items: [] });
        if (url.pathname.endsWith('/primary-guardian-periods')) return jsonResponse({ items: [] });
        if (url.pathname.endsWith('/payer-snapshots')) return jsonResponse({ items: [] });
        if (url.pathname.endsWith('/plan-notifications')) return jsonResponse({ items: [] });
        return jsonResponse({
          id: 32,
          name: serverName,
          birth_date: '1950-03-15',
          sex_code: 'FEMALE',
          recipient_status: serverStatus,
          recipient_no: 'R-032',
          postal_code: null,
          address: null,
          home_phone: null,
          mobile_phone: '010-1111-2222',
          memo: null,
          row_version: serverRowVersion,
        });
      }
      return jsonResponse({ detail: { code: 'not_found' } }, 404);
    }) as typeof globalThis.fetch;

    render(<RecipientsPage />);
    fireEvent.click(await screen.findByRole('button', { name: /상태충돌원본/ }));
    await waitFor(() => expect(screen.getByTestId('recipient-detail-name-input')).toHaveValue('상태충돌원본'));
    expect(screen.getByTestId('recipient-detail-status-select')).toHaveValue('ACTIVE');

    // Concurrent server: status ENDED only; name unchanged so no same-field collision on name.
    serverRowVersion = 5;
    serverStatus = 'ENDED';

    fireEvent.change(screen.getByTestId('recipient-detail-name-input'), {
      target: { value: '이름만수정' },
    });
    expect(screen.getByTestId('recipient-detail-status-select')).toHaveValue('ACTIVE');
    fireEvent.click(await screen.findByRole('button', { name: '기본정보 저장' }));

    const conflictAlerts = await screen.findAllByRole('alert');
    expect(conflictAlerts).toHaveLength(1);
    expect(conflictAlerts[0].textContent).toBe(
      '다른 사용자가 먼저 변경했습니다. 최신 서버값을 확인하고 필요한 변경만 다시 적용해주세요.',
    );
    await waitFor(() =>
      expect(screen.getByTestId('recipient-stale-latest-value')).toHaveTextContent('상태충돌원본'),
    );
    // User name preserved; form shows server ENDED for status (merged baseline).
    expect(screen.getByTestId('recipient-detail-name-input')).toHaveValue('이름만수정');
    expect(screen.getByTestId('recipient-detail-status-select')).toHaveValue('ENDED');

    // Re-edit name after conflict; reapply must send re-edited value, not the pre-conflict draft alone.
    fireEvent.change(screen.getByTestId('recipient-detail-name-input'), {
      target: { value: '재편집이름' },
    });
    fireEvent.click(screen.getByTestId('recipient-stale-reapply'));
    await waitFor(() =>
      expect(patchBodies.some((body) => body.expected_row_version === 5)).toBe(true),
    );
    const reapplyBody = patchBodies.find((body) => body.expected_row_version === 5);
    expect(reapplyBody).toEqual({
      expected_row_version: 5,
      name: '재편집이름',
    });
    expect(reapplyBody).not.toHaveProperty('recipient_status');

    await waitFor(() =>
      expect(screen.getByText('최신 버전에 변경 내용을 다시 적용했습니다.')).toBeInTheDocument(),
    );
    expect(screen.getByTestId('recipient-detail-status-select')).toHaveValue('ENDED');
    expect(screen.getByTestId('recipient-detail-name-input')).toHaveValue('재편집이름');
    expect(serverStatus).toBe('ENDED');
  });

  test('same-field ROW_VERSION_CONFLICT shows exact alert, separate conflict log, no reapply', async () => {
    const patchBodies: Array<Record<string, unknown>> = [];
    let serverRowVersion = 1;
    let serverName = '동일필드충돌';
    let serverStatus: 'ACTIVE' | 'ENDED' | 'WAITING' = 'ACTIVE';

    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const rawUrl =
        typeof input === 'string' ? input : input instanceof Request ? input.url : input.toString();
      const url = new URL(rawUrl, 'http://localhost');
      const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();

      if (url.pathname === '/api/v1/recipients' && method === 'GET') {
        return jsonResponse(
          listResponse([listItem({ id: 33, name: serverName, row_version: serverRowVersion })]),
        );
      }
      if (/^\/api\/v1\/recipients\/\d+$/.test(url.pathname) && method === 'PATCH') {
        const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
        patchBodies.push(body);
        if (Number(body.expected_row_version) !== serverRowVersion) {
          return jsonResponse(
            {
              error: {
                code: 'ROW_VERSION_CONFLICT',
                message: '다른 사용자가 먼저 변경했습니다. 최신 정보를 다시 불러오세요.',
              },
              field_errors: [],
              details: { current_row_version: serverRowVersion },
              request_id: 't-same-field',
            },
            409,
          );
        }
        if (typeof body.name === 'string') serverName = body.name;
        if (typeof body.recipient_status === 'string') {
          serverStatus = body.recipient_status as 'ACTIVE' | 'ENDED' | 'WAITING';
        }
        serverRowVersion = Number(body.expected_row_version) + 1;
        return jsonResponse({
          id: 33,
          name: serverName,
          birth_date: '1950-03-15',
          sex_code: 'FEMALE',
          recipient_status: serverStatus,
          recipient_no: 'R-033',
          postal_code: null,
          address: null,
          home_phone: null,
          mobile_phone: '010-1111-2222',
          memo: null,
          row_version: serverRowVersion,
        });
      }
      if (url.pathname.startsWith('/api/v1/recipients/') && method === 'GET') {
        if (url.pathname.endsWith('/guardians')) return jsonResponse({ items: [] });
        if (url.pathname.endsWith('/primary-guardian-periods')) return jsonResponse({ items: [] });
        if (url.pathname.endsWith('/payer-snapshots')) return jsonResponse({ items: [] });
        if (url.pathname.endsWith('/plan-notifications')) return jsonResponse({ items: [] });
        return jsonResponse({
          id: 33,
          name: serverName,
          birth_date: '1950-03-15',
          sex_code: 'FEMALE',
          recipient_status: serverStatus,
          recipient_no: 'R-033',
          postal_code: null,
          address: null,
          home_phone: null,
          mobile_phone: '010-1111-2222',
          memo: null,
          row_version: serverRowVersion,
        });
      }
      return jsonResponse({ detail: { code: 'not_found' } }, 404);
    }) as typeof globalThis.fetch;

    render(<RecipientsPage />);
    fireEvent.click(await screen.findByRole('button', { name: /동일필드충돌/ }));
    await waitFor(() => expect(screen.getByTestId('recipient-detail-name-input')).toHaveValue('동일필드충돌'));

    // Concurrent server also changed name (same field as user draft).
    serverRowVersion = 5;
    serverName = '서버이름';

    fireEvent.change(screen.getByTestId('recipient-detail-name-input'), {
      target: { value: '사용자이름' },
    });
    fireEvent.click(await screen.findByRole('button', { name: '기본정보 저장' }));

    const alerts = await screen.findAllByRole('alert');
    expect(alerts).toHaveLength(1);
    expect(alerts[0].textContent).toBe('이미 수정되었습니다');
    // Latest server values + conflict log must sit outside the alert.
    expect(alerts[0].textContent).not.toContain('사용자이름');
    expect(alerts[0].textContent).not.toContain('서버이름');
    expect(screen.getByTestId('recipient-stale-latest-value')).toHaveTextContent('서버이름');
    const conflictLog = screen.getByTestId('recipient-same-field-conflict-log');
    expect(conflictLog).toBeInTheDocument();
    expect(conflictLog).not.toHaveAttribute('role', 'alert');
    expect(screen.getByTestId('recipient-conflict-field-name')).toHaveTextContent('이름');
    expect(screen.getByTestId('recipient-conflict-field-name')).toHaveTextContent('사용자이름');
    expect(screen.getByTestId('recipient-conflict-field-name')).toHaveTextContent('서버이름');
    // Form field set to server latest; no automatic reapply.
    expect(screen.getByTestId('recipient-detail-name-input')).toHaveValue('서버이름');
    expect(screen.queryByTestId('recipient-stale-reapply')).toBeNull();
    // Only the initial failing PATCH; no auto reapply PATCH.
    expect(patchBodies).toHaveLength(1);

    // User must re-edit the latest baseline before saving the conflicting field.
    fireEvent.change(screen.getByTestId('recipient-detail-name-input'), {
      target: { value: '재편집후이름' },
    });
    fireEvent.click(screen.getByTestId('recipient-detail-save'));
    await waitFor(() => expect(patchBodies.length).toBe(2));
    expect(patchBodies[1]).toEqual({
      expected_row_version: 5,
      name: '재편집후이름',
    });
  });

  test('mixed same-field + disjoint ROW_VERSION_CONFLICT preserves non-conflicting user edit', async () => {
    // User changes name + status; server changes only name → name→server, status preserved.
    const patchBodies: Array<Record<string, unknown>> = [];
    let serverRowVersion = 1;
    let serverName = '혼합충돌원본';
    let serverStatus: 'ACTIVE' | 'ENDED' | 'WAITING' = 'ACTIVE';

    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const rawUrl =
        typeof input === 'string' ? input : input instanceof Request ? input.url : input.toString();
      const url = new URL(rawUrl, 'http://localhost');
      const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();

      if (url.pathname === '/api/v1/recipients' && method === 'GET') {
        return jsonResponse(
          listResponse([listItem({ id: 36, name: serverName, row_version: serverRowVersion })]),
        );
      }
      if (/^\/api\/v1\/recipients\/\d+$/.test(url.pathname) && method === 'PATCH') {
        const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
        patchBodies.push(body);
        if (Number(body.expected_row_version) !== serverRowVersion) {
          return jsonResponse(
            {
              error: {
                code: 'ROW_VERSION_CONFLICT',
                message: '다른 사용자가 먼저 변경했습니다. 최신 정보를 다시 불러오세요.',
              },
              field_errors: [],
              details: { current_row_version: serverRowVersion },
              request_id: 't-mixed-conflict',
            },
            409,
          );
        }
        if (typeof body.name === 'string') serverName = body.name;
        if (typeof body.recipient_status === 'string') {
          serverStatus = body.recipient_status as 'ACTIVE' | 'ENDED' | 'WAITING';
        }
        serverRowVersion = Number(body.expected_row_version) + 1;
        return jsonResponse({
          id: 36,
          name: serverName,
          birth_date: '1950-03-15',
          sex_code: 'FEMALE',
          recipient_status: serverStatus,
          recipient_no: 'R-036',
          postal_code: null,
          address: null,
          home_phone: null,
          mobile_phone: '010-1111-2222',
          memo: null,
          row_version: serverRowVersion,
        });
      }
      if (url.pathname.startsWith('/api/v1/recipients/') && method === 'GET') {
        if (url.pathname.endsWith('/guardians')) return jsonResponse({ items: [] });
        if (url.pathname.endsWith('/primary-guardian-periods')) return jsonResponse({ items: [] });
        if (url.pathname.endsWith('/payer-snapshots')) return jsonResponse({ items: [] });
        if (url.pathname.endsWith('/plan-notifications')) return jsonResponse({ items: [] });
        return jsonResponse({
          id: 36,
          name: serverName,
          birth_date: '1950-03-15',
          sex_code: 'FEMALE',
          recipient_status: serverStatus,
          recipient_no: 'R-036',
          postal_code: null,
          address: null,
          home_phone: null,
          mobile_phone: '010-1111-2222',
          memo: null,
          row_version: serverRowVersion,
        });
      }
      return jsonResponse({ detail: { code: 'not_found' } }, 404);
    }) as typeof globalThis.fetch;

    render(<RecipientsPage />);
    fireEvent.click(await screen.findByRole('button', { name: /혼합충돌원본/ }));
    await waitFor(() => expect(screen.getByTestId('recipient-detail-name-input')).toHaveValue('혼합충돌원본'));

    serverRowVersion = 7;
    serverName = '서버혼합이름';

    fireEvent.change(screen.getByTestId('recipient-detail-name-input'), {
      target: { value: '사용자혼합이름' },
    });
    fireEvent.change(screen.getByTestId('recipient-detail-status-select'), {
      target: { value: 'WAITING' },
    });
    fireEvent.click(await screen.findByRole('button', { name: '기본정보 저장' }));

    const alerts = await screen.findAllByRole('alert');
    expect(alerts).toHaveLength(1);
    expect(alerts[0].textContent).toBe('이미 수정되었습니다');
    expect(screen.getByTestId('recipient-conflict-field-name')).toHaveTextContent('사용자혼합이름');
    expect(screen.getByTestId('recipient-conflict-field-name')).toHaveTextContent('서버혼합이름');
    // Same-field name → server; disjoint status → preserved.
    expect(screen.getByTestId('recipient-detail-name-input')).toHaveValue('서버혼합이름');
    expect(screen.getByTestId('recipient-detail-status-select')).toHaveValue('WAITING');
    expect(screen.queryByTestId('recipient-stale-reapply')).toBeNull();
    expect(patchBodies).toHaveLength(1);

    // Save remaining disjoint edit against latest row_version (no stale draft resend of name).
    fireEvent.click(screen.getByTestId('recipient-detail-save'));
    await waitFor(() => expect(patchBodies.length).toBe(2));
    expect(patchBodies[1]).toEqual({
      expected_row_version: 7,
      recipient_status: 'WAITING',
    });
    expect(patchBodies[1]).not.toHaveProperty('name');
  });

  test('no-op Save is disabled and sends zero PATCH; exact keys for name/status/both; whitespace/null no-op', async () => {
    const patchBodies: Array<Record<string, unknown>> = [];
    let serverName = '변경감지';
    let serverStatus: 'ACTIVE' | 'ENDED' | 'WAITING' = 'ACTIVE';
    let serverVersion = 1;
    let serverMemo: string | null = null;
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const rawUrl =
        typeof input === 'string' ? input : input instanceof Request ? input.url : input.toString();
      const url = new URL(rawUrl, 'http://localhost');
      const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();

      if (url.pathname === '/api/v1/recipients' && method === 'GET') {
        return jsonResponse(listResponse([listItem({ id: 34, name: serverName })]));
      }
      if (/^\/api\/v1\/recipients\/\d+$/.test(url.pathname) && method === 'PATCH') {
        const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
        patchBodies.push(body);
        if (typeof body.name === 'string') serverName = body.name;
        if (typeof body.recipient_status === 'string') {
          serverStatus = body.recipient_status as 'ACTIVE' | 'ENDED' | 'WAITING';
        }
        if ('memo' in body) serverMemo = (body.memo as string | null) ?? null;
        serverVersion = Number(body.expected_row_version) + 1;
        return jsonResponse({
          id: 34,
          name: serverName,
          birth_date: '1950-03-15',
          sex_code: 'FEMALE',
          recipient_status: serverStatus,
          recipient_no: 'R-034',
          postal_code: null,
          address: null,
          home_phone: null,
          mobile_phone: '010-1111-2222',
          memo: serverMemo,
          row_version: serverVersion,
        });
      }
      if (url.pathname.startsWith('/api/v1/recipients/') && method === 'GET') {
        if (url.pathname.endsWith('/guardians')) return jsonResponse({ items: [] });
        if (url.pathname.endsWith('/primary-guardian-periods')) return jsonResponse({ items: [] });
        if (url.pathname.endsWith('/payer-snapshots')) return jsonResponse({ items: [] });
        if (url.pathname.endsWith('/plan-notifications')) return jsonResponse({ items: [] });
        return jsonResponse({
          id: 34,
          name: serverName,
          birth_date: '1950-03-15',
          sex_code: 'FEMALE',
          recipient_status: serverStatus,
          recipient_no: 'R-034',
          postal_code: null,
          address: null,
          home_phone: null,
          mobile_phone: '010-1111-2222',
          memo: serverMemo,
          row_version: serverVersion,
        });
      }
      return jsonResponse({ detail: { code: 'not_found' } }, 404);
    }) as typeof globalThis.fetch;

    render(<RecipientsPage />);
    fireEvent.click(await screen.findByRole('button', { name: /변경감지/ }));
    await waitFor(() => expect(screen.getByTestId('recipient-detail-name-input')).toHaveValue('변경감지'));

    const save = screen.getByTestId('recipient-detail-save');
    expect(save).toBeDisabled();
    fireEvent.click(save);
    expect(patchBodies).toHaveLength(0);

    // Trailing whitespace on name that trims equal to baseline → no-op (disabled Save, zero PATCH).
    fireEvent.change(screen.getByTestId('recipient-detail-name-input'), {
      target: { value: '변경감지   ' },
    });
    expect(save).toBeDisabled();
    fireEvent.click(save);
    expect(patchBodies).toHaveLength(0);

    // Empty / whitespace-only memo when server memo is null → null equivalence no-op.
    const detailFormEl = screen.getByTestId('recipient-detail-name-input').closest('form');
    expect(detailFormEl).not.toBeNull();
    const memoField = detailFormEl!.querySelector('textarea');
    expect(memoField).not.toBeNull();
    fireEvent.change(memoField!, { target: { value: '   ' } });
    expect(save).toBeDisabled();
    fireEvent.click(save);
    expect(patchBodies).toHaveLength(0);
    fireEvent.change(memoField!, { target: { value: '' } });
    expect(save).toBeDisabled();

    // Name-only — exact key set
    fireEvent.change(screen.getByTestId('recipient-detail-name-input'), {
      target: { value: '이름변경' },
    });
    expect(save).not.toBeDisabled();
    fireEvent.click(save);
    await waitFor(() => expect(patchBodies.length).toBe(1));
    expect(Object.keys(patchBodies[0] as object).sort()).toEqual(
      ['expected_row_version', 'name'].sort(),
    );
    expect(patchBodies[0]).toEqual({ name: '이름변경', expected_row_version: 1 });

    // After success form matches server; save disabled again.
    await waitFor(() => expect(save).toBeDisabled());

    // Status-only — exact key set
    fireEvent.change(screen.getByTestId('recipient-detail-status-select'), {
      target: { value: 'ENDED' },
    });
    expect(save).not.toBeDisabled();
    fireEvent.click(save);
    await waitFor(() => expect(patchBodies.length).toBe(2));
    expect(Object.keys(patchBodies[1] as object).sort()).toEqual(
      ['expected_row_version', 'recipient_status'].sort(),
    );
    expect(patchBodies[1]).toEqual({ recipient_status: 'ENDED', expected_row_version: 2 });
    await waitFor(() => expect(save).toBeDisabled());

    // Both — exact key set
    fireEvent.change(screen.getByTestId('recipient-detail-name-input'), {
      target: { value: '둘다' },
    });
    fireEvent.change(screen.getByTestId('recipient-detail-status-select'), {
      target: { value: 'WAITING' },
    });
    fireEvent.click(save);
    await waitFor(() => expect(patchBodies.length).toBe(3));
    expect(Object.keys(patchBodies[2] as object).sort()).toEqual(
      ['expected_row_version', 'name', 'recipient_status'].sort(),
    );
    expect(patchBodies[2]).toEqual({
      name: '둘다',
      recipient_status: 'WAITING',
      expected_row_version: 3,
    });
    await waitFor(() => expect(save).toBeDisabled());

    // Revert-to-original disables Save without PATCH
    fireEvent.change(screen.getByTestId('recipient-detail-name-input'), {
      target: { value: '임시' },
    });
    expect(save).not.toBeDisabled();
    fireEvent.change(screen.getByTestId('recipient-detail-name-input'), {
      target: { value: '둘다' },
    });
    expect(save).toBeDisabled();
    expect(patchBodies).toHaveLength(3);
  });

  test('malformed detail (null recipient_status) blocks editor and Save/PATCH', async () => {
    const patchBodies: unknown[] = [];
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const rawUrl =
        typeof input === 'string' ? input : input instanceof Request ? input.url : input.toString();
      const url = new URL(rawUrl, 'http://localhost');
      const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();

      if (url.pathname === '/api/v1/recipients' && method === 'GET') {
        return jsonResponse(listResponse([listItem({ id: 35, name: '불량상세' })]));
      }
      if (/^\/api\/v1\/recipients\/\d+$/.test(url.pathname) && method === 'PATCH') {
        patchBodies.push(JSON.parse(String(init?.body ?? '{}')));
        return jsonResponse({ detail: { code: 'no' } }, 500);
      }
      if (url.pathname.startsWith('/api/v1/recipients/') && method === 'GET') {
        if (url.pathname.endsWith('/guardians')) return jsonResponse({ items: [] });
        if (url.pathname.endsWith('/primary-guardian-periods')) return jsonResponse({ items: [] });
        if (url.pathname.endsWith('/payer-snapshots')) return jsonResponse({ items: [] });
        if (url.pathname.endsWith('/plan-notifications')) return jsonResponse({ items: [] });
        return jsonResponse({
          id: 35,
          name: '불량상세',
          birth_date: '1950-03-15',
          sex_code: 'FEMALE',
          recipient_status: null,
          recipient_no: 'R-035',
          postal_code: null,
          address: null,
          home_phone: null,
          mobile_phone: '010-1111-2222',
          memo: null,
          row_version: 1,
        });
      }
      return jsonResponse({ detail: { code: 'not_found' } }, 404);
    }) as typeof globalThis.fetch;

    render(<RecipientsPage />);
    fireEvent.click(await screen.findByRole('button', { name: /불량상세/ }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toMatch(/올바르지 않아|불러오지 못/);
    expect(screen.queryByTestId('recipient-detail-status-select')).toBeNull();
    expect(screen.queryByTestId('recipient-detail-save')).toBeNull();
    expect(patchBodies).toHaveLength(0);
  });

  test('malformed detail (wrong recipient id) blocks editor and Save/PATCH', async () => {
    const patchBodies: unknown[] = [];
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const rawUrl =
        typeof input === 'string' ? input : input instanceof Request ? input.url : input.toString();
      const url = new URL(rawUrl, 'http://localhost');
      const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();

      if (url.pathname === '/api/v1/recipients' && method === 'GET') {
        return jsonResponse(listResponse([listItem({ id: 36, name: '잘못된아이디' })]));
      }
      if (/^\/api\/v1\/recipients\/\d+$/.test(url.pathname) && method === 'PATCH') {
        patchBodies.push(JSON.parse(String(init?.body ?? '{}')));
        return jsonResponse({ detail: { code: 'no' } }, 500);
      }
      if (url.pathname.startsWith('/api/v1/recipients/') && method === 'GET') {
        if (url.pathname.endsWith('/guardians')) return jsonResponse({ items: [] });
        if (url.pathname.endsWith('/primary-guardian-periods')) return jsonResponse({ items: [] });
        if (url.pathname.endsWith('/payer-snapshots')) return jsonResponse({ items: [] });
        if (url.pathname.endsWith('/plan-notifications')) return jsonResponse({ items: [] });
        return jsonResponse({
          id: 9999,
          name: '잘못된아이디',
          birth_date: '1950-03-15',
          sex_code: 'FEMALE',
          recipient_status: 'ACTIVE',
          recipient_no: 'R-036',
          postal_code: null,
          address: null,
          home_phone: null,
          mobile_phone: '010-1111-2222',
          memo: null,
          row_version: 1,
        });
      }
      return jsonResponse({ detail: { code: 'not_found' } }, 404);
    }) as typeof globalThis.fetch;

    render(<RecipientsPage />);
    fireEvent.click(await screen.findByRole('button', { name: /잘못된아이디/ }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toMatch(/올바르지 않아|불러오지 못/);
    expect(screen.queryByTestId('recipient-detail-status-select')).toBeNull();
    expect(screen.queryByTestId('recipient-detail-save')).toBeNull();
    expect(patchBodies).toHaveLength(0);
  });

  test('malformed detail (missing recipient_status) blocks editor and Save/PATCH', async () => {
    const patchBodies: unknown[] = [];
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const rawUrl =
        typeof input === 'string' ? input : input instanceof Request ? input.url : input.toString();
      const url = new URL(rawUrl, 'http://localhost');
      const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();

      if (url.pathname === '/api/v1/recipients' && method === 'GET') {
        return jsonResponse(listResponse([listItem({ id: 37, name: '상태누락' })]));
      }
      if (/^\/api\/v1\/recipients\/\d+$/.test(url.pathname) && method === 'PATCH') {
        patchBodies.push(JSON.parse(String(init?.body ?? '{}')));
        return jsonResponse({ detail: { code: 'no' } }, 500);
      }
      if (url.pathname.startsWith('/api/v1/recipients/') && method === 'GET') {
        if (url.pathname.endsWith('/guardians')) return jsonResponse({ items: [] });
        if (url.pathname.endsWith('/primary-guardian-periods')) return jsonResponse({ items: [] });
        if (url.pathname.endsWith('/payer-snapshots')) return jsonResponse({ items: [] });
        if (url.pathname.endsWith('/plan-notifications')) return jsonResponse({ items: [] });
        return jsonResponse({
          id: 37,
          name: '상태누락',
          birth_date: '1950-03-15',
          sex_code: 'FEMALE',
          recipient_no: 'R-037',
          postal_code: null,
          address: null,
          home_phone: null,
          mobile_phone: '010-1111-2222',
          memo: null,
          row_version: 1,
        });
      }
      return jsonResponse({ detail: { code: 'not_found' } }, 404);
    }) as typeof globalThis.fetch;

    render(<RecipientsPage />);
    fireEvent.click(await screen.findByRole('button', { name: /상태누락/ }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toMatch(/올바르지 않아|불러오지 못/);
    expect(screen.queryByTestId('recipient-detail-status-select')).toBeNull();
    expect(screen.queryByTestId('recipient-detail-save')).toBeNull();
    expect(patchBodies).toHaveLength(0);
  });

  test('malformed detail (invalid recipient_status) blocks editor and Save/PATCH', async () => {
    const patchBodies: unknown[] = [];
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const rawUrl =
        typeof input === 'string' ? input : input instanceof Request ? input.url : input.toString();
      const url = new URL(rawUrl, 'http://localhost');
      const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();

      if (url.pathname === '/api/v1/recipients' && method === 'GET') {
        return jsonResponse(listResponse([listItem({ id: 38, name: '상태무효' })]));
      }
      if (/^\/api\/v1\/recipients\/\d+$/.test(url.pathname) && method === 'PATCH') {
        patchBodies.push(JSON.parse(String(init?.body ?? '{}')));
        return jsonResponse({ detail: { code: 'no' } }, 500);
      }
      if (url.pathname.startsWith('/api/v1/recipients/') && method === 'GET') {
        if (url.pathname.endsWith('/guardians')) return jsonResponse({ items: [] });
        if (url.pathname.endsWith('/primary-guardian-periods')) return jsonResponse({ items: [] });
        if (url.pathname.endsWith('/payer-snapshots')) return jsonResponse({ items: [] });
        if (url.pathname.endsWith('/plan-notifications')) return jsonResponse({ items: [] });
        return jsonResponse({
          id: 38,
          name: '상태무효',
          birth_date: '1950-03-15',
          sex_code: 'FEMALE',
          recipient_status: 'HISTORY',
          recipient_no: 'R-038',
          postal_code: null,
          address: null,
          home_phone: null,
          mobile_phone: '010-1111-2222',
          memo: null,
          row_version: 1,
        });
      }
      return jsonResponse({ detail: { code: 'not_found' } }, 404);
    }) as typeof globalThis.fetch;

    render(<RecipientsPage />);
    fireEvent.click(await screen.findByRole('button', { name: /상태무효/ }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toMatch(/올바르지 않아|불러오지 못/);
    expect(screen.queryByTestId('recipient-detail-status-select')).toBeNull();
    expect(screen.queryByTestId('recipient-detail-save')).toBeNull();
    expect(patchBodies).toHaveLength(0);
  });

  test('detail inputs and Save disabled while save in flight', async () => {
    const patchBodies: unknown[] = [];
    let releasePatch: ((value: Response) => void) | null = null;
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const rawUrl =
        typeof input === 'string' ? input : input instanceof Request ? input.url : input.toString();
      const url = new URL(rawUrl, 'http://localhost');
      const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();

      if (url.pathname === '/api/v1/recipients' && method === 'GET') {
        return jsonResponse(listResponse([listItem({ id: 39, name: '저장중잠금' })]));
      }
      if (/^\/api\/v1\/recipients\/\d+$/.test(url.pathname) && method === 'PATCH') {
        patchBodies.push(JSON.parse(String(init?.body ?? '{}')));
        return new Promise<Response>((resolve) => {
          releasePatch = resolve;
        });
      }
      if (url.pathname.startsWith('/api/v1/recipients/') && method === 'GET') {
        if (url.pathname.endsWith('/guardians')) return jsonResponse({ items: [] });
        if (url.pathname.endsWith('/primary-guardian-periods')) return jsonResponse({ items: [] });
        if (url.pathname.endsWith('/payer-snapshots')) return jsonResponse({ items: [] });
        if (url.pathname.endsWith('/plan-notifications')) return jsonResponse({ items: [] });
        return jsonResponse({
          id: 39,
          name: '저장중잠금',
          birth_date: '1950-03-15',
          sex_code: 'FEMALE',
          recipient_status: 'ACTIVE',
          recipient_no: 'R-039',
          postal_code: null,
          address: null,
          home_phone: null,
          mobile_phone: '010-1111-2222',
          memo: null,
          row_version: 1,
        });
      }
      return jsonResponse({ detail: { code: 'not_found' } }, 404);
    }) as typeof globalThis.fetch;

    render(<RecipientsPage />);
    fireEvent.click(await screen.findByRole('button', { name: /저장중잠금/ }));
    await waitFor(() => expect(screen.getByTestId('recipient-detail-name-input')).toHaveValue('저장중잠금'));

    fireEvent.change(screen.getByTestId('recipient-detail-name-input'), {
      target: { value: '저장중이름' },
    });
    fireEvent.click(screen.getByTestId('recipient-detail-save'));

    await waitFor(() => expect(patchBodies).toHaveLength(1));
    // Every detail input/select and Save must be disabled while save is in flight.
    expect(screen.getByTestId('recipient-detail-name-input')).toBeDisabled();
    expect(screen.getByTestId('recipient-detail-birth-date-input')).toBeDisabled();
    expect(screen.getByTestId('recipient-detail-sex-code-select')).toBeDisabled();
    expect(screen.getByTestId('recipient-detail-status-select')).toBeDisabled();
    const detailForm = screen.getByTestId('recipient-detail-name-input').closest('form');
    expect(detailForm).not.toBeNull();
    const pendingInputs = detailForm!.querySelectorAll('input, select, textarea');
    expect(pendingInputs.length).toBeGreaterThanOrEqual(9);
    pendingInputs.forEach((node) => {
      expect(node).toBeDisabled();
    });
    expect(screen.getByTestId('recipient-detail-save')).toBeDisabled();

    releasePatch?.(
      jsonResponse({
        id: 39,
        name: '저장중이름',
        birth_date: '1950-03-15',
        sex_code: 'FEMALE',
        recipient_status: 'ACTIVE',
        recipient_no: 'R-039',
        postal_code: null,
        address: null,
        home_phone: null,
        mobile_phone: '010-1111-2222',
        memo: null,
        row_version: 2,
      }),
    );
    await waitFor(() => expect(screen.getByTestId('recipient-detail-name-input')).not.toBeDisabled());
    expect(screen.getByTestId('recipient-detail-name-input')).toHaveValue('저장중이름');
    expect(screen.getByTestId('recipient-detail-save')).toBeDisabled();
  });

  test('create POST payload has no recipient_status field', async () => {
    const postBodies: unknown[] = [];
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const rawUrl =
        typeof input === 'string' ? input : input instanceof Request ? input.url : input.toString();
      const url = new URL(rawUrl, 'http://localhost');
      const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();

      if (url.pathname === '/api/v1/recipients' && method === 'GET') {
        return jsonResponse(listResponse([]));
      }
      if (url.pathname === '/api/v1/recipients' && method === 'POST') {
        const body = JSON.parse(String(init?.body ?? '{}'));
        postBodies.push(body);
        return jsonResponse({
          id: 99,
          name: body.name,
          birth_date: body.birth_date,
          sex_code: body.sex_code,
          recipient_status: 'ACTIVE',
          recipient_no: null,
          postal_code: body.postal_code ?? null,
          address: body.address ?? null,
          home_phone: body.home_phone ?? null,
          mobile_phone: body.mobile_phone ?? null,
          memo: body.memo ?? null,
          row_version: 1,
        }, 201);
      }
      if (url.pathname.startsWith('/api/v1/recipients/') && method === 'GET') {
        if (url.pathname.endsWith('/guardians')) return jsonResponse({ items: [] });
        if (url.pathname.endsWith('/primary-guardian-periods')) return jsonResponse({ items: [] });
        if (url.pathname.endsWith('/payer-snapshots')) return jsonResponse({ items: [] });
        if (url.pathname.endsWith('/plan-notifications')) return jsonResponse({ items: [] });
        return jsonResponse({
          id: 99,
          name: '생성수급',
          birth_date: '1960-01-01',
          sex_code: 'MALE',
          recipient_status: 'ACTIVE',
          recipient_no: null,
          postal_code: null,
          address: null,
          home_phone: null,
          mobile_phone: '010-1234-5678',
          memo: null,
          row_version: 1,
        });
      }
      return jsonResponse({ detail: { code: 'not_found' } }, 404);
    }) as typeof globalThis.fetch;

    render(<RecipientsPage />);
    fireEvent.click(await screen.findByTestId('recipient-create-toggle'));
    fireEvent.change(screen.getByTestId('recipient-name-input'), { target: { value: '생성수급' } });
    fireEvent.change(screen.getByTestId('recipient-birth-date-input'), {
      target: { value: '1960-01-01' },
    });
    fireEvent.change(screen.getByTestId('recipient-mobile-phone-input'), {
      target: { value: '01012345678' },
    });
    const createForm = document.getElementById('recipient-create-form');
    expect(createForm).toBeTruthy();
    fireEvent.submit(createForm!);

    await waitFor(() => expect(postBodies.length).toBe(1));
    const body = postBodies[0] as Record<string, unknown>;
    expect(body).not.toHaveProperty('recipient_status');
    expect(Object.keys(body)).not.toContain('recipient_status');
    expect(body.name).toBe('생성수급');
  });

  test('renders grade_code, benefit_code, copayment_rate, and multi services from server response', async () => {
    installRecipientListFetch(() =>
      listResponse([
        listItem({
          id: 7,
          name: '표시검증',
          grade_code: '4',
          benefit_code: 'REDUCED',
          copayment_rate: 7.5,
          services: [
            {
              service_group_code: 'DAY',
              display_name: '주야간보호',
              service_types: [
                { service_type_code: 'D1', display_name: '주간' },
                { service_type_code: 'D2', display_name: '야간' },
              ],
            },
            {
              service_group_code: 'NURSE',
              display_name: '방문간호',
              service_types: [{ service_type_code: 'N1', display_name: '기본간호' }],
            },
          ],
        }),
      ]),
    );

    render(<RecipientsPage />);

    const row = await screen.findByRole('button', { name: /표시검증/ });
    expect(within(row).getByTestId('recipient-list-grade')).toHaveTextContent('4등급');
    expect(within(row).getByTestId('recipient-list-benefit')).toHaveTextContent('REDUCED');
    expect(within(row).getByTestId('recipient-list-copay-rate')).toHaveTextContent('7.5%');
    expect(within(row).getByTestId('recipient-list-services')).toHaveTextContent('주야간보호');
    expect(within(row).getByTestId('recipient-list-services')).toHaveTextContent('주간');
    expect(within(row).getByTestId('recipient-list-services')).toHaveTextContent('야간');
    expect(within(row).getByTestId('recipient-list-services')).toHaveTextContent('방문간호');
    expect(within(row).getByTestId('recipient-list-services')).toHaveTextContent('기본간호');
  });

  test('null projection fields render honest empty labels without inventing values', async () => {
    installRecipientListFetch(() =>
      listResponse([
        listItem({
          id: 3,
          name: '널표시',
          grade_code: null,
          benefit_code: null,
          copayment_rate: null,
          services: [],
        }),
      ]),
    );

    render(<RecipientsPage />);

    const row = await screen.findByRole('button', { name: /널표시/ });
    expect(within(row).getByTestId('recipient-list-grade')).toHaveTextContent('미지정');
    expect(within(row).getByTestId('recipient-list-benefit')).toHaveTextContent('없음');
    expect(within(row).getByTestId('recipient-list-copay-rate')).toHaveTextContent('미지정');
    expect(within(row).getByTestId('recipient-list-services')).toHaveTextContent('없음');
  });

  test('list keeps five columns and has no prev/next/page indicator', async () => {
    installRecipientListFetch(() =>
      listResponse([listItem({ id: 1, name: '컬럼검증' })]),
    );
    render(<RecipientsPage />);
    await screen.findByRole('button', { name: /컬럼검증/ });

    const header = screen.getByTestId('recipient-list-header');
    const headerLabels = within(header)
      .getAllByText(/./)
      .map((node) => node.textContent?.trim())
      .filter(Boolean);
    // Header is five direct spans: 등급, 이름, 나이, 본·부%, 제공중 서비스.
    expect(header.children).toHaveLength(5);
    expect([...header.children].map((node) => node.textContent)).toEqual([
      '등급',
      '이름',
      '나이',
      '본·부%',
      '제공중 서비스',
    ]);
    expect(headerLabels).toEqual(['등급', '이름', '나이', '본·부%', '제공중 서비스']);

    expect(screen.queryByTestId('recipient-page-prev')).toBeNull();
    expect(screen.queryByTestId('recipient-page-next')).toBeNull();
    expect(screen.queryByTestId('recipient-page-indicator')).toBeNull();
    expect(document.querySelector('.recipient-list-footer')).toBeNull();
  });

  test('search resets to page 1; scroll appends page 2 without replacing prior rows', async () => {
    const { requests } = installRecipientListFetch((query) => {
      const page = Number(query.page ?? '1');
      if (query.search === '검색어') {
        return listResponse(
          [listItem({ id: 99, name: '서버검색결과', grade_code: '2' })],
          1,
          1,
          100,
        );
      }
      if (page === 2) {
        return listResponse(
          [listItem({ id: 20, name: '페이지2행', grade_code: '1' })],
          3,
          2,
          2,
        );
      }
      // Deliberately reverse of name ASC so client sort would fail the assertion.
      return listResponse(
        [
          listItem({ id: 2, name: '홍길동', grade_code: '5' }),
          listItem({ id: 1, name: '가나다', grade_code: '3' }),
        ],
        3,
        1,
        2,
      );
    });

    render(<RecipientsPage />);

    await waitFor(() => expect(requests.length).toBeGreaterThan(0));
    expect(requests[0].page).toBe('1');
    const namesOnFirstPaint = screen
      .getAllByTestId('recipient-name-option')
      .map((node) => node.textContent ?? '');
    expect(namesOnFirstPaint[0]).toContain('홍길동');
    expect(namesOnFirstPaint[1]).toContain('가나다');

    fireEvent.change(screen.getByTestId('recipient-search-input'), {
      target: { value: '검색어' },
    });

    await waitFor(() => {
      expect(requests.at(-1)?.search).toBe('검색어');
      expect(requests.at(-1)?.page).toBe('1');
    });
    expect(await screen.findByRole('button', { name: /서버검색결과/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /홍길동/ })).toBeNull();

    // Reset search so infinite-scroll uses the multi-page total fixture.
    fireEvent.change(screen.getByTestId('recipient-search-input'), {
      target: { value: '' },
    });
    await waitFor(() => {
      expect(requests.at(-1)?.search).toBeNull();
      expect(requests.at(-1)?.page).toBe('1');
    });
    expect(await screen.findByRole('button', { name: /홍길동/ })).toBeInTheDocument();

    const beforeAppend = requests.length;
    scrollListNearBottom();

    await waitFor(() => expect(requests.at(-1)?.page).toBe('2'));
    expect(requests.length).toBe(beforeAppend + 1);
    expect(await screen.findByRole('button', { name: /페이지2행/ })).toBeInTheDocument();
    // Append keeps page-1 rows.
    expect(screen.getByRole('button', { name: /홍길동/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /가나다/ })).toBeInTheDocument();
  });

  test('infinite scroll dedupes by id, stops at total, and guards concurrent load-more', async () => {
    const { requests } = installRecipientListFetch((query) => {
      const page = Number(query.page ?? '1');
      const pageSize = 2;
      const all = [
        listItem({ id: 1, name: 'A수급' }),
        listItem({ id: 2, name: 'B수급' }),
        listItem({ id: 3, name: 'C수급' }),
        listItem({ id: 4, name: 'D수급' }),
        listItem({ id: 5, name: 'E수급' }),
      ];
      if (page === 1) {
        return listResponse(all.slice(0, 2), all.length, 1, pageSize);
      }
      if (page === 2) {
        // Intentionally include id 2 again so the client must dedupe on append.
        return listResponse(
          [listItem({ id: 2, name: 'B수급-중복' }), listItem({ id: 3, name: 'C수급' })],
          all.length,
          2,
          pageSize,
        );
      }
      if (page === 3) {
        return listResponse(all.slice(3, 5), all.length, 3, pageSize);
      }
      // Past total: empty page must not be requested by the client after hasMore=false.
      return listResponse([], all.length, page, pageSize);
    });

    render(<RecipientsPage />);
    await waitFor(() => expect(requests.length).toBeGreaterThan(0));
    expect(requests[0]).toEqual(
      expect.objectContaining({ page: '1', page_size: '100', status: 'ACTIVE' }),
    );
    expect(await screen.findByRole('button', { name: /A수급/ })).toBeInTheDocument();
    expect(screen.getAllByTestId('recipient-name-option')).toHaveLength(2);

    // Concurrent near-bottom scrolls must not fire multiple page-2 requests.
    scrollListNearBottom();
    scrollListNearBottom();
    scrollListNearBottom();

    await waitFor(() => expect(requests.some((request) => request.page === '2')).toBe(true));
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /C수급/ })).toBeInTheDocument();
    });
    const page2Count = requests.filter((request) => request.page === '2').length;
    expect(page2Count).toBe(1);
    // id=2 kept once (first occurrence), not replaced by duplicate page-2 payload name.
    const rowsAfterPage2 = screen.getAllByTestId('recipient-name-option');
    expect(rowsAfterPage2).toHaveLength(3);
    expect(rowsAfterPage2.map((node) => node.textContent ?? '').join('|')).toContain('B수급');
    expect(rowsAfterPage2.map((node) => node.textContent ?? '').join('|')).not.toContain('B수급-중복');

    scrollListNearBottom();
    await waitFor(() => expect(requests.some((request) => request.page === '3')).toBe(true));
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /E수급/ })).toBeInTheDocument();
    });
    // items.length (5) >= total (5) → no further page requests.
    const afterTotal = requests.length;
    scrollListNearBottom();
    scrollListNearBottom();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(requests.length).toBe(afterTotal);
    expect(requests.filter((request) => request.page === '4')).toHaveLength(0);
    expect(screen.getAllByTestId('recipient-name-option')).toHaveLength(5);
  });

  test('status change resets rows to page 1; stale delayed page-2 does not overwrite', async () => {
    type Pending = {
      query: ListQuery;
      resolve: (response: Response) => void;
      signal?: AbortSignal | null;
    };
    const pending: Pending[] = [];
    const requests: ListQuery[] = [];
    // Sentinel: increments when the late ACTIVE page-2 body is actually decoded (json()).
    // DOM-only waitFor can pass before page-2 settles; this observes real continuation.
    let latePage2Settled = 0;

    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const rawUrl =
        typeof input === 'string' ? input : input instanceof Request ? input.url : input.toString();
      const url = new URL(rawUrl, 'http://localhost');
      const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();

      if (url.pathname === '/api/v1/recipients' && method === 'GET') {
        const query = parseListQuery(url);
        requests.push(query);
        return new Promise<Response>((resolve, reject) => {
          const entry: Pending = { query, resolve, signal: init?.signal ?? null };
          // page-2: uncooperative server — observe abort via signal.aborted but do not
          // reject the promise, so a late resolve can still reach generation/stale guards.
          // page-1 (initial ACTIVE + new ENDED): keep cooperative abort + manual resolve.
          if (query.page === '2') {
            pending.push(entry);
            return;
          }
          const onAbort = () => {
            const abortError = new Error('Aborted');
            abortError.name = 'AbortError';
            reject(abortError);
          };
          if (init?.signal?.aborted) {
            onAbort();
            return;
          }
          init?.signal?.addEventListener('abort', onAbort, { once: true });
          pending.push(entry);
        });
      }

      if (url.pathname.startsWith('/api/v1/recipients/') && method === 'GET') {
        if (url.pathname.endsWith('/guardians')) return jsonResponse({ items: [] });
        if (url.pathname.endsWith('/primary-guardian-periods')) return jsonResponse({ items: [] });
        if (url.pathname.endsWith('/payer-snapshots')) return jsonResponse({ items: [] });
        if (url.pathname.endsWith('/plan-notifications')) return jsonResponse({ items: [] });
        return jsonResponse({
          id: 1,
          name: '지연행',
          birth_date: '1950-03-15',
          sex_code: 'FEMALE',
          recipient_status: 'ACTIVE' as const,
          recipient_no: 'R-001',
          postal_code: null,
          address: null,
          home_phone: null,
          mobile_phone: '010-1111-2222',
          memo: null,
          row_version: 1,
        });
      }
      return jsonResponse({ detail: { code: 'not_found' } }, 404);
    }) as typeof globalThis.fetch;

    render(<RecipientsPage />);
    await waitFor(() => expect(pending.length).toBe(1));
    pending[0].resolve(
      jsonResponse(
        listResponse(
          [listItem({ id: 1, name: '이용중행' }), listItem({ id: 2, name: '이용중행2' })],
          4,
          1,
          2,
        ),
      ),
    );
    // Exact strong name: must not match '이용중행2' (substring/accessible-name clash).
    await waitFor(() => {
      expect(hasRecipientRowWithExactName('이용중행')).toBe(true);
    });

    scrollListNearBottom();
    await waitFor(() => expect(requests.some((request) => request.page === '2')).toBe(true));
    const page2Pending = pending.filter((entry) => entry.query.page === '2');
    expect(page2Pending.length).toBe(1);
    const page2Signal = page2Pending[0].signal;
    expect(page2Signal).toBeTruthy();
    // Still in flight before filter change.
    expect(page2Signal!.aborted).toBe(false);

    // Change status before page-2 resolves → reset to page 1 under new status.
    fireEvent.change(screen.getByTestId('recipient-filter-select'), {
      target: { value: 'ENDED' },
    });
    await waitFor(() =>
      expect(requests.some((request) => request.status === 'ENDED' && request.page === '1')).toBe(
        true,
      ),
    );
    await waitFor(() => {
      expect(hasRecipientRowWithExactName('이용중행')).toBe(false);
      expect(screen.getByTestId('recipient-list-loading')).toBeInTheDocument();
    });

    // Abort evidence first: filter reset must abort the in-flight load-more signal.
    await waitFor(() => {
      expect(page2Signal!.aborted).toBe(true);
    });
    // Real abort was true. Temporarily force aborted=false so apiRequest processes the late
    // body fully — this isolates generation/stale guard from the abort-only short-circuit.
    expect(page2Signal!.aborted).toBe(true);
    Object.defineProperty(page2Signal!, 'aborted', {
      configurable: true,
      enumerable: true,
      get: () => false,
    });
    expect(page2Signal!.aborted).toBe(false);

    // Apply new ENDED page-1 first so the list is non-null before the late page-2 arrives.
    // (If page-2 resolved while current===null, !current replace could mask missing guards.)
    const endedPage1 = pending.filter(
      (entry) => entry.query.status === 'ENDED' && entry.query.page === '1',
    );
    expect(endedPage1.length).toBeGreaterThan(0);
    endedPage1[endedPage1.length - 1].resolve(
      jsonResponse(listResponse([listItem({ id: 30, name: '계약종료행' })], 1, 1, 100)),
    );

    expect(await screen.findByRole('button', { name: /계약종료행/ })).toBeInTheDocument();
    expect(screen.getAllByTestId('recipient-name-option')).toHaveLength(1);
    expect(hasRecipientRowWithExactName('이용중행')).toBe(false);
    expect(hasRecipientRowWithExactName('늦은페이지2')).toBe(false);

    // Late page-2 (old ACTIVE filter) must not append into the already-applied ENDED list.
    // Response-like fixture: count json decode so waitFor cannot succeed before continuation.
    page2Pending[0].resolve({
      ok: true,
      status: 200,
      headers: new Headers({ 'Content-Type': 'application/json' }),
      json: async () => {
        latePage2Settled += 1;
        return listResponse([listItem({ id: 90, name: '늦은페이지2' })], 4, 2, 2);
      },
    } as Response);

    // First: observe real late page-2 decode/continuation (not pre-true DOM conditions).
    await waitFor(() => expect(latePage2Settled).toBe(1));

    // Then: final DOM — generation guard must have dropped the stale append.
    // If the guard is removed, late page-2 appends and this assertion fails.
    expect(screen.getAllByTestId('recipient-name-option')).toHaveLength(1);
    expect(hasRecipientRowWithExactName('계약종료행')).toBe(true);
    expect(screen.queryByRole('button', { name: /늦은페이지2/ })).toBeNull();
    expect(hasRecipientRowWithExactName('늦은페이지2')).toBe(false);
  });

  test('list row keeps full multi-line service and copay text in the DOM (M1)', async () => {
    const longServices = [
      {
        service_group_code: 'VISIT',
        display_name: '방문요양',
        service_types: [
          { service_type_code: 'V1', display_name: '일반방문요양서비스' },
          { service_type_code: 'V2', display_name: '야간방문요양서비스' },
          { service_type_code: 'V3', display_name: '휴일방문요양서비스' },
        ],
      },
      {
        service_group_code: 'BATH',
        display_name: '방문목욕',
        service_types: [
          { service_type_code: 'B1', display_name: '차량목욕서비스' },
          { service_type_code: 'B2', display_name: '가정내목욕서비스' },
        ],
      },
      {
        service_group_code: 'NURSE',
        display_name: '방문간호',
        service_types: [{ service_type_code: 'N1', display_name: '기본간호서비스' }],
      },
    ];
    const expectedServices =
      '방문요양: 일반방문요양서비스, 야간방문요양서비스, 휴일방문요양서비스 · 방문목욕: 차량목욕서비스, 가정내목욕서비스 · 방문간호: 기본간호서비스';

    installRecipientListFetch(() =>
      listResponse([
        listItem({
          id: 42,
          name: '긴서비스행',
          benefit_code: 'REDUCED_SPECIAL',
          copayment_rate: 7.5,
          services: longServices,
        }),
      ]),
    );

    render(<RecipientsPage />);

    const row = await screen.findByRole('button', { name: /긴서비스행/ });
    const servicesCell = within(row).getByTestId('recipient-list-services');
    const copayCell = within(row).getByTestId('recipient-list-copay');

    expect(servicesCell).toHaveTextContent(expectedServices);
    expect(servicesCell.textContent).toBe(expectedServices);
    expect(within(row).getByTestId('recipient-list-benefit')).toHaveTextContent('REDUCED_SPECIAL');
    expect(within(row).getByTestId('recipient-list-copay-rate')).toHaveTextContent('7.5%');
    expect(copayCell).toHaveTextContent('REDUCED_SPECIAL');
    expect(copayCell).toHaveTextContent('7.5%');
    expect(servicesCell.className).toContain('recipient-list-services');
    expect(copayCell.className).toContain('recipient-list-copay');
  });

  test('recipient-list-row CSS does not clip multi-line service/copay with fixed height (M1)', () => {
    const css = readFileSync(recipientsCssPath, 'utf8');
    // Prefer the sizing rule (min-height) over the shared grid template rule.
    const rowRules = [...css.matchAll(/button\.recipient-list-row\s*\{[^}]+\}/g)].map((match) => match[0]);
    const sizingRule = rowRules.find((rule) => /min-height\s*:/.test(rule));
    expect(sizingRule, 'button.recipient-list-row sizing rule missing').toBeTruthy();

    expect(sizingRule!).toMatch(/(?:^|[^\w-])height:\s*auto/);
    expect(sizingRule!).toMatch(/min-height:\s*45px/);
    expect(sizingRule!).toMatch(/overflow:\s*visible/);
    // Reject fixed row height (do not match min-height:45px).
    expect(sizingRule!).not.toMatch(/(?:^|[^\w-])height:\s*45px\b/);
    expect(sizingRule!).not.toMatch(/overflow:\s*hidden/);

    const servicesRuleMatch = css.match(/\.recipient-list-services\s*\{[^}]+\}/);
    expect(servicesRuleMatch, '.recipient-list-services rule missing').toBeTruthy();
    expect(servicesRuleMatch![0]).toMatch(/white-space:\s*normal/);
    expect(servicesRuleMatch![0]).toMatch(/overflow:\s*visible/);

    const copayRuleMatch = css.match(/\.recipient-list-copay\s*\{[^}]+\}/);
    expect(copayRuleMatch, '.recipient-list-copay rule missing').toBeTruthy();
    expect(copayRuleMatch![0]).toMatch(/white-space:\s*normal/);
    expect(copayRuleMatch![0]).toMatch(/overflow:\s*visible/);
  });

  test('detail and create summary never show a fabricated certification number (M2)', async () => {
    installRecipientListFetch(() =>
      listResponse([listItem({ id: 11, name: '인정번호검증', recipient_no: 'R-FAKE-001' })]),
    );

    render(<RecipientsPage />);

    fireEvent.click(await screen.findByRole('button', { name: /인정번호검증/ }));
    const detailCert = await screen.findByTestId('recipient-detail-certification-number');
    expect(detailCert).toHaveTextContent('미지정');
    expect(screen.queryByText('L1234567890')).toBeNull();
    // Do not reuse recipient_no or other IDs as 인정번호.
    expect(detailCert).not.toHaveTextContent('R-FAKE-001');
    expect(detailCert).not.toHaveTextContent('11');

    fireEvent.click(screen.getByTestId('recipient-create-toggle'));
    const createCert = await screen.findByTestId('recipient-create-certification-number');
    expect(createCert).toHaveTextContent('미지정');
    expect(screen.queryByText('L1234567890')).toBeNull();
  });

  test('status/error CSS does not reintroduce ancestor display:none hiding (MAJ-1/MAJ-2)', () => {
    const css = readFileSync(recipientsCssPath, 'utf8');

    // Collect rule blocks: selector { declarations }. Handles multi-selector rules.
    const ruleBlocks = [
      ...css.matchAll(/([^{}@][^{]*)\{([^}]*)\}/g),
    ].map((match) => ({
      selector: match[1].replace(/\s+/g, ' ').trim(),
      body: match[2],
    }));

    const hidesWithDisplayNone = (body: string) => /display\s*:\s*none/i.test(body);

    // Regression that caused false-green: only searching `.recipients-page ….<class>`
    // missed bare `.recipient-page-heading { display:none }` which hid the status chip.
    for (const rule of ruleBlocks) {
      if (!hidesWithDisplayNone(rule.body)) continue;

      // Entire heading must not be display:none (status chip is a descendant).
      const headingSubjects = rule.selector
        .split(',')
        .map((part) => part.trim())
        .filter((part) => /(^|[\s>+~])\.recipient-page-heading(\s|$|:|,|$)/.test(part) || part === '.recipient-page-heading');
      for (const subject of headingSubjects) {
        // Allow hiding only non-status children, e.g. `.recipient-page-heading > :not(.recipient-page-status)`.
        if (/\.recipient-page-heading\s*>/.test(subject) || /\.recipient-page-heading\s+/.test(subject)) {
          continue;
        }
        if (/(^|[\s>+~])\.recipient-page-heading$/.test(subject) || subject === '.recipient-page-heading') {
          expect.fail(
            `MAJ-1 regression: .recipient-page-heading must not use display:none (hides status chip). Rule: ${rule.selector} { ${rule.body.trim()} }`,
          );
        }
      }

      // Status / error surfaces themselves must not be hidden.
      // Ignore :not(.class) mentions — those are exclusions, not subjects being hidden.
      const selectorWithoutNots = rule.selector.replace(/:not\([^)]*\)/g, '');
      const protectedClasses = [
        'recipient-page-status',
        'recipient-status',
        'recipient-status-loading',
        'recipient-status-error',
        'recipient-inline-error',
        'recipient-save-error',
        'recipient-state-error',
      ];
      for (const className of protectedClasses) {
        const classRe = new RegExp(`\\.${className}\\b`);
        if (!classRe.test(selectorWithoutNots)) continue;
        // Ignore :empty empty-state hide — still ban bare display:none on the surface.
        if (new RegExp(`\\.${className}\\s*:empty\\b`).test(rule.selector)) continue;
        expect.fail(
          `MAJ-1 regression: .${className} must not use display:none. Rule: ${rule.selector} { ${rule.body.trim()} }`,
        );
      }
    }

    // Base error text color must remain visible styling (not a hide rule).
    const inlineErrorColor = css.match(/\.recipient-inline-error[^{]*\{[^}]*\}/);
    expect(inlineErrorColor, '.recipient-inline-error color rule missing').toBeTruthy();
    expect(inlineErrorColor![0]).not.toMatch(/display\s*:\s*none/);
  });

  test('list error text renders with role=alert (DOM only; jsdom does not compute CSS layout) (MAJ-2)', async () => {
    // Honest limitation: jsdom does not apply CSS layout/visibility. This asserts
    // error copy is present in the accessibility tree / DOM when list load fails.
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const rawUrl =
        typeof input === 'string' ? input : input instanceof Request ? input.url : input.toString();
      const url = new URL(rawUrl, 'http://localhost');
      const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
      if (url.pathname === '/api/v1/recipients' && method === 'GET') {
        return jsonResponse({ detail: { code: 'server_error', message: '목록 실패' } }, 500);
      }
      return jsonResponse({ detail: { code: 'not_found' } }, 404);
    }) as typeof globalThis.fetch;

    render(<RecipientsPage />);

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveClass('recipient-inline-error');
    expect(alert.textContent).toBeTruthy();

    // Status chip for list error must also be in the DOM (CSS visibility not asserted here).
    const status = await screen.findByTestId('recipient-list-status');
    expect(status).toHaveAttribute('aria-live', 'polite');
    expect(within(status).getByText('목록 확인 필요')).toBeTruthy();
  });

  test('detail summary grade/copay follow matching list projection for active detail id', async () => {
    installRecipientListFetch(() =>
      listResponse([
        listItem({
          id: 15,
          name: '등급본인부담',
          grade_code: '3',
          copayment_rate: 15,
        }),
      ]),
    );

    render(<RecipientsPage />);

    fireEvent.click(await screen.findByRole('button', { name: /등급본인부담/ }));

    // Detail GET (RecipientResponse) has no grade_code/copayment_rate; list projection supplies them.
    const grade = await screen.findByTestId('recipient-detail-grade');
    const copay = screen.getByTestId('recipient-detail-copay');
    expect(grade).toHaveTextContent('3등급');
    expect(copay).toHaveTextContent('15%');
    // List row stays consistent with the same formatters.
    const row = screen.getByRole('button', { name: /등급본인부담/ });
    expect(within(row).getByTestId('recipient-list-grade')).toHaveTextContent('3등급');
    expect(within(row).getByTestId('recipient-list-copay-rate')).toHaveTextContent('15%');
  });

  test('detail grade/copay use 미지정 when active detail id is not in the current list page', async () => {
    installRecipientListFetch(() =>
      listResponse([listItem({ id: 1, name: '현재페이지수급', grade_code: '2', copayment_rate: 20 })]),
    );

    // selected/detail point at an id not in the current list page → no matching list projection.
    window.history.replaceState({}, '', '/recipients?selected=999&detail=999');
    render(<RecipientsPage />);

    const grade = await screen.findByTestId('recipient-detail-grade');
    const copay = screen.getByTestId('recipient-detail-copay');
    expect(grade).toHaveTextContent('미지정');
    expect(copay).toHaveTextContent('미지정');
    // Must not invent values from the unrelated list row or recipient_no.
    expect(grade).not.toHaveTextContent('2등급');
    expect(copay).not.toHaveTextContent('20%');
  });

  test('detail grade/copay do not mis-attribute first list row when deep-link targets another id (MAJ-3)', async () => {
    // A is first list row (selectedRecipient fallback when selected is absent).
    // B is detail deep-link target with different grade/copay.
    installRecipientListFetch(() =>
      listResponse([
        listItem({ id: 1, name: 'A수급', grade_code: '1', copayment_rate: 20 }),
        listItem({ id: 2, name: 'B수급', grade_code: '5', copayment_rate: 7.5 }),
      ]),
    );

    // selected absent → selectedRecipient falls back to A; detail=B is the active target.
    window.history.replaceState({}, '', '/recipients?detail=2');
    render(<RecipientsPage />);

    const grade = await screen.findByTestId('recipient-detail-grade');
    const copay = screen.getByTestId('recipient-detail-copay');
    // Must show B's list projection, never A's (old selectedRecipient bug).
    expect(grade).toHaveTextContent('5등급');
    expect(copay).toHaveTextContent('7.5%');
    expect(grade).not.toHaveTextContent('1등급');
    expect(copay).not.toHaveTextContent('20%');
  });

  test('create form does not offer savable grade/copay inputs (MAJ-4)', async () => {
    installRecipientListFetch(() => listResponse([listItem({ id: 1, name: '김수급' })]));
    render(<RecipientsPage />);

    fireEvent.click(await screen.findByTestId('recipient-create-toggle'));

    // RecipientCreateRequest has no grade/copay — no editable select may remain.
    expect(screen.queryByTestId('recipient-grade-select')).toBeNull();
    expect(screen.queryByTestId('recipient-copay-select')).toBeNull();
    // Contract-honest read-only 미지정 display (same pattern as 인정번호).
    expect(await screen.findByTestId('recipient-create-grade')).toHaveTextContent('미지정');
    expect(screen.getByTestId('recipient-create-copay')).toHaveTextContent('미지정');
  });

  test('idle CSS does not hide create actions or all heading buttons (MAJ-A static CSS)', () => {
    // Static CSS contract only — jsdom does not compute layout/visibility.
    const css = readFileSync(recipientsCssPath, 'utf8');
    const ruleBlocks = [...css.matchAll(/([^{}@][^{]*)\{([^}]*)\}/g)].map((match) => ({
      selector: match[1].replace(/\s+/g, ' ').trim(),
      body: match[2],
    }));

    const hidesWithDisplayNone = (body: string) => /display\s*:\s*none/i.test(body);

    for (const rule of ruleBlocks) {
      if (!hidesWithDisplayNone(rule.body)) continue;

      for (const part of rule.selector.split(',').map((s) => s.trim())) {
        if (!/\.recipient-detail-panel\.is-idle\b/.test(part)) continue;

        // Ban hiding the whole create action group (blocks 수급자 등록 with empty list).
        // Subject is the group itself, not a descendant of it.
        const withoutNots = part.replace(/:not\([^)]*\)/g, '');
        if (/\.recipient-create-actions\s*$/.test(withoutNots) || /\.recipient-create-actions:[^\s]*\s*$/.test(withoutNots)) {
          expect.fail(
            `MAJ-A regression: idle must not hide .recipient-create-actions entirely. Rule: ${rule.selector} { ${rule.body.trim()} }`,
          );
        }

        // Ban blanket heading button hide; allow only specific toggles (e.g. detail-toggle).
        if (
          /\.recipient-detail-heading\b/.test(part) &&
          /(^|[\s>+~])button(\s|$|:)/.test(withoutNots) &&
          !/\.recipient-detail-toggle\b/.test(part)
        ) {
          expect.fail(
            `MAJ-A regression: idle must not hide all heading buttons. Rule: ${rule.selector} { ${rule.body.trim()} }`,
          );
        }
      }
    }

    // Positive contract: create-open idle path carves out the form host section.
    const idleCreatingRule = ruleBlocks.find((rule) =>
      /\.recipient-detail-panel\.is-idle\.is-creating\b/.test(rule.selector),
    );
    expect(
      idleCreatingRule,
      'MAJ-A: expected .recipient-detail-panel.is-idle.is-creating exception rule for create form visibility',
    ).toBeTruthy();
    expect(idleCreatingRule!.selector).toMatch(/recipient-basic-section/);
  });

  test('empty list: create toggle opens form; createError can surface as role=alert (MAJ-A DOM)', async () => {
    // DOM contract only — does not assert computed CSS visibility/layout in jsdom.
    installRecipientListFetch(() => listResponse([], 0));

    render(<RecipientsPage />);

    // Wait for empty list settle; create toggle must be present without a selected row.
    const createToggle = await screen.findByTestId('recipient-create-toggle');
    expect(createToggle).toHaveTextContent('수급자 등록');

    const workspace = screen.getByTestId('recipient-detail-workspace');
    expect(workspace.className).toMatch(/\bis-idle\b/);
    expect(workspace.className).not.toMatch(/\bis-creating\b/);

    fireEvent.click(createToggle);

    // createOpen → form mounts; panel marked is-creating so CSS idle hide does not cover it.
    expect(await screen.findByTestId('recipient-name-input')).toBeTruthy();
    const createForm = document.getElementById('recipient-create-form');
    expect(createForm).toBeTruthy();
    expect(workspace.className).toMatch(/\bis-creating\b/);
    expect(workspace.className).toMatch(/\bis-idle\b/);

    // Invalid submit (empty mobile) surfaces createError as role=alert inside the form.
    fireEvent.submit(createForm!);
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveClass('recipient-inline-error');
    expect(alert.textContent).toBeTruthy();
  });

  test('list age uses 만 나이 (international full age) with birthday boundary, not year-diff+1', async () => {
    // Fixed clock at a UTC/KST boundary: 2025-06-15 15:30 UTC is already 2025-06-16 in Asia/Seoul.
    // Host-local UTC getFullYear/getMonth/getDate would still see 2025-06-15 and under-count a 6/16 birthday.
    // Result-only asserts are host-dependent: Asia/Seoul hosts can still pass if timeZone is deleted.
    const fixedNow = new Date('2025-06-15T15:30:00.000Z');
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(fixedNow);
    // Construct-safe spy: vitest's default spy call-through does not preserve `new` for
    // Intl.DateTimeFormat, so formatToParts would be undefined on the returned value.
    const OriginalDateTimeFormat = Intl.DateTimeFormat;
    const dateTimeFormatSpy = vi.spyOn(Intl, 'DateTimeFormat').mockImplementation(
      function MockDateTimeFormat(
        this: Intl.DateTimeFormat,
        ...args: ConstructorParameters<typeof Intl.DateTimeFormat>
      ) {
        return Reflect.construct(OriginalDateTimeFormat, args);
      } as typeof Intl.DateTimeFormat,
    );
    try {
      // Seoul calendar day 2025-06-16 → 30세 on birthday; UTC-local day 2025-06-15 → would show 29세.
      const onSeoulBirthday = '1995-06-16';
      // One calendar day later than the 30-year anniversary in Seoul → birthday not yet reached.
      const notYetSeoulBirthday = '1995-06-17';
      // year-diff+1 counting age for a ~30-year-old is 31; list must not show that.
      const wrongCountingAge = '31세';

      installRecipientListFetch(() =>
        listResponse([
          listItem({ id: 1, name: '생일당일', birth_date: onSeoulBirthday }),
          listItem({ id: 2, name: '생일전', birth_date: notYetSeoulBirthday }),
        ]),
      );

      render(<RecipientsPage />);

      const onBirthdayRow = await screen.findByRole('button', { name: /생일당일/ });
      const beforeBirthdayRow = await screen.findByRole('button', { name: /생일전/ });

      expect(within(onBirthdayRow).getByTestId('recipient-list-age')).toHaveTextContent('30세');
      expect(within(beforeBirthdayRow).getByTestId('recipient-list-age')).toHaveTextContent('29세');
      expect(within(onBirthdayRow).getByTestId('recipient-list-age')).not.toHaveTextContent(wrongCountingAge);
      expect(within(beforeBirthdayRow).getByTestId('recipient-list-age')).not.toHaveTextContent(wrongCountingAge);
      // Prove UTC-local calendar-day math fails this boundary (would render 29세 for 생일당일).
      expect(within(onBirthdayRow).getByTestId('recipient-list-age')).not.toHaveTextContent('29세');
      // Mutation-sensitive / host-independent: production must pass timeZone Asia/Seoul to the formatter.
      expect(dateTimeFormatSpy).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ timeZone: 'Asia/Seoul' }),
      );
    } finally {
      dateTimeFormatSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  test('query change clears old rows/total while loading; failure clears list projection', async () => {
    type Pending = {
      query: ListQuery;
      resolve: (response: Response) => void;
    };
    const pending: Pending[] = [];
    const requests: ListQuery[] = [];

    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const rawUrl =
        typeof input === 'string' ? input : input instanceof Request ? input.url : input.toString();
      const url = new URL(rawUrl, 'http://localhost');
      const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();

      if (url.pathname === '/api/v1/recipients' && method === 'GET') {
        const query = parseListQuery(url);
        requests.push(query);
        return new Promise<Response>((resolve) => {
          pending.push({ query, resolve });
        });
      }

      if (url.pathname.startsWith('/api/v1/recipients/') && method === 'GET') {
        if (url.pathname.endsWith('/guardians')) return jsonResponse({ items: [] });
        if (url.pathname.endsWith('/primary-guardian-periods')) return jsonResponse({ items: [] });
        if (url.pathname.endsWith('/payer-snapshots')) return jsonResponse({ items: [] });
        if (url.pathname.endsWith('/plan-notifications')) return jsonResponse({ items: [] });
        const id = Number(url.pathname.split('/').pop());
        const item = listItem({ id: Number.isFinite(id) ? id : 1 });
        return jsonResponse({
          id: item.id,
          name: item.name,
          birth_date: item.birth_date,
          sex_code: item.sex_code,
          recipient_status: 'ACTIVE' as const,
          recipient_no: item.recipient_no,
          postal_code: item.postal_code,
          address: item.address,
          home_phone: item.home_phone,
          mobile_phone: item.mobile_phone,
          memo: item.memo,
          row_version: item.row_version,
        });
      }

      return jsonResponse({ detail: { code: 'not_found' } }, 404);
    }) as typeof globalThis.fetch;

    render(<RecipientsPage />);

    await waitFor(() => expect(pending.length).toBe(1));
    pending[0].resolve(
      jsonResponse(listResponse([listItem({ id: 1, name: '이전목록행' })], 7, 1, 100)),
    );

    expect(await screen.findByRole('button', { name: /이전목록행/ })).toBeInTheDocument();
    expect(screen.getByTestId('recipient-count')).toHaveTextContent('총 7명');

    fireEvent.change(screen.getByTestId('recipient-search-input'), {
      target: { value: '신규검색' },
    });

    await waitFor(() => expect(requests.some((request) => request.search === '신규검색')).toBe(true));
    // Stale projection must not remain under the new query while loading.
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: /이전목록행/ })).toBeNull();
      expect(screen.getByTestId('recipient-count')).toHaveTextContent('총 0명');
      expect(screen.getByTestId('recipient-list-loading')).toBeInTheDocument();
    });

    const searchPending = pending.filter((entry) => entry.query.search === '신규검색');
    expect(searchPending.length).toBeGreaterThan(0);
    searchPending[searchPending.length - 1].resolve(
      jsonResponse(listResponse([listItem({ id: 2, name: '검색결과행' })], 4, 1, 100)),
    );
    expect(await screen.findByRole('button', { name: /검색결과행/ })).toBeInTheDocument();
    expect(screen.getByTestId('recipient-count')).toHaveTextContent('총 4명');

    // Status change must also drop prior rows/total while the deferred response is pending.
    fireEvent.change(screen.getByTestId('recipient-filter-select'), {
      target: { value: 'ENDED' },
    });
    await waitFor(() => expect(requests.some((request) => request.status === 'ENDED')).toBe(true));
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: /검색결과행/ })).toBeNull();
      expect(screen.getByTestId('recipient-count')).toHaveTextContent('총 0명');
      expect(screen.getByTestId('recipient-list-loading')).toBeInTheDocument();
    });
    const statusPending = pending.filter((entry) => entry.query.status === 'ENDED');
    expect(statusPending.length).toBeGreaterThan(0);
    statusPending[statusPending.length - 1].resolve(
      jsonResponse(listResponse([listItem({ id: 3, name: '상태결과행' })], 5, 1, 2)),
    );
    expect(await screen.findByRole('button', { name: /상태결과행/ })).toBeInTheDocument();
    expect(screen.getByTestId('recipient-count')).toHaveTextContent('총 5명');

    // Append (page 2) failure keeps already-loaded rows; surface error without clearing projection.
    scrollListNearBottom();
    await waitFor(() => expect(requests.some((request) => request.page === '2')).toBe(true));
    // Existing rows remain visible while the append request is in flight.
    expect(screen.getByRole('button', { name: /상태결과행/ })).toBeInTheDocument();
    expect(screen.getByTestId('recipient-count')).toHaveTextContent('총 5명');

    const pagePending = pending.filter((entry) => entry.query.page === '2');
    expect(pagePending.length).toBeGreaterThan(0);
    pagePending[pagePending.length - 1].resolve(
      jsonResponse({ detail: { code: 'server_error', message: '목록 실패' } }, 500),
    );

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveClass('recipient-inline-error');
    // Page-1 projection is preserved after append failure (not replaced by empty).
    expect(screen.getByRole('button', { name: /상태결과행/ })).toBeInTheDocument();
    expect(screen.getByTestId('recipient-count')).toHaveTextContent('총 5명');
    expect(screen.queryByRole('button', { name: /이전목록행/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /검색결과행/ })).toBeNull();
  });

  test('same-query listReload failure clears rows/total after successful projection', async () => {
    type Pending = {
      query: ListQuery;
      resolve: (response: Response) => void;
    };
    const pending: Pending[] = [];
    const requests: ListQuery[] = [];

    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const rawUrl =
        typeof input === 'string' ? input : input instanceof Request ? input.url : input.toString();
      const url = new URL(rawUrl, 'http://localhost');
      const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();

      if (url.pathname === '/api/v1/recipients' && method === 'GET') {
        const query = parseListQuery(url);
        requests.push(query);
        return new Promise<Response>((resolve) => {
          pending.push({ query, resolve });
        });
      }

      // Detail save bumps listReload (same search/status/page) after a successful PATCH.
      if (/^\/api\/v1\/recipients\/\d+$/.test(url.pathname) && method === 'PATCH') {
        const id = Number(url.pathname.split('/').pop());
        const item = listItem({ id: Number.isFinite(id) ? id : 1, name: '성공목록행' });
        return jsonResponse({
          id: item.id,
          name: item.name,
          birth_date: item.birth_date,
          sex_code: item.sex_code,
          recipient_status: 'ACTIVE' as const,
          recipient_no: item.recipient_no,
          postal_code: item.postal_code,
          address: item.address,
          home_phone: item.home_phone,
          mobile_phone: item.mobile_phone,
          memo: item.memo,
          row_version: item.row_version + 1,
        });
      }

      if (url.pathname.startsWith('/api/v1/recipients/') && method === 'GET') {
        if (url.pathname.endsWith('/guardians')) return jsonResponse({ items: [] });
        if (url.pathname.endsWith('/primary-guardian-periods')) return jsonResponse({ items: [] });
        if (url.pathname.endsWith('/payer-snapshots')) return jsonResponse({ items: [] });
        if (url.pathname.endsWith('/plan-notifications')) return jsonResponse({ items: [] });
        const id = Number(url.pathname.split('/').pop());
        const item = listItem({ id: Number.isFinite(id) ? id : 1, name: '성공목록행' });
        return jsonResponse({
          id: item.id,
          name: item.name,
          birth_date: item.birth_date,
          sex_code: item.sex_code,
          recipient_status: 'ACTIVE' as const,
          recipient_no: item.recipient_no,
          postal_code: item.postal_code,
          address: item.address,
          home_phone: item.home_phone,
          mobile_phone: item.mobile_phone,
          memo: item.memo,
          row_version: item.row_version,
        });
      }

      return jsonResponse({ detail: { code: 'not_found' } }, 404);
    }) as typeof globalThis.fetch;

    render(<RecipientsPage />);

    await waitFor(() => expect(pending.length).toBe(1));
    pending[0].resolve(
      jsonResponse(listResponse([listItem({ id: 1, name: '성공목록행' })], 3, 1, 100)),
    );

    expect(await screen.findByRole('button', { name: /성공목록행/ })).toBeInTheDocument();
    expect(screen.getByTestId('recipient-count')).toHaveTextContent('총 3명');

    // Editable form appears only after successful detail GET (not list-only identity).
    await waitFor(() => {
      expect(screen.getByTestId('recipient-detail-name-input')).toHaveValue('성공목록행');
    });

    // No-op save is disabled; change a field so save can trigger listReload (same query key).
    const saveButton = await screen.findByRole('button', { name: '기본정보 저장' });
    expect(saveButton).toBeDisabled();
    fireEvent.change(screen.getByTestId('recipient-detail-name-input'), {
      target: { value: '성공목록행수정' },
    });
    expect(saveButton).not.toBeDisabled();
    fireEvent.click(saveButton);

    await waitFor(() => expect(pending.length).toBeGreaterThan(1));
    const reloadPending = pending[pending.length - 1];
    // Same query as the successful projection (no search/status/page change).
    expect(reloadPending.query).toEqual(requests[0]);
    // Same-query reload keeps prior rows until the response settles; catch must clear them.
    expect(screen.getByRole('button', { name: /성공목록행/ })).toBeInTheDocument();
    expect(screen.getByTestId('recipient-count')).toHaveTextContent('총 3명');

    reloadPending.resolve(
      jsonResponse({ detail: { code: 'server_error', message: '목록 실패' } }, 500),
    );

    // Deleting catch-side setListData(null) would leave rows/total from the prior success.
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: /성공목록행/ })).toBeNull();
      expect(screen.getByTestId('recipient-count')).toHaveTextContent('총 0명');
    });
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveClass('recipient-inline-error');
    expect(screen.queryByTestId('recipient-list-loading')).toBeNull();
  });

  test('after query change, selected/detail absent from new page is cleared (first-row policy; no prior detail)', async () => {
    const { requests } = installRecipientListFetch((query) => {
      if (query.search === '다른필터') {
        return listResponse(
          [listItem({ id: 50, name: '새페이지수급', grade_code: '1', copayment_rate: 20 })],
          1,
        );
      }
      return listResponse(
        [
          listItem({ id: 10, name: '이전선택수급', grade_code: '3', copayment_rate: 15 }),
          listItem({ id: 11, name: '이전다른수급', grade_code: '4', copayment_rate: 7.5 }),
        ],
        2,
      );
    });

    window.history.replaceState({}, '', '/recipients?selected=10&detail=10');
    render(<RecipientsPage />);

    fireEvent.click(await screen.findByRole('button', { name: /이전선택수급/ }));
    expect(await screen.findByTestId('recipient-detail-grade')).toHaveTextContent('3등급');
    expect(screen.getByTestId('recipient-detail-copay')).toHaveTextContent('15%');

    fireEvent.change(screen.getByTestId('recipient-search-input'), {
      target: { value: '다른필터' },
    });

    await waitFor(() => expect(requests.at(-1)?.search).toBe('다른필터'));
    expect(await screen.findByRole('button', { name: /새페이지수급/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /이전선택수급/ })).toBeNull();

    // Prior page detail must not remain; first-row policy selects the only new row.
    await waitFor(() => {
      expect(window.location.search).toMatch(/selected=50/);
      expect(window.location.search).not.toMatch(/detail=10/);
      expect(window.location.search).not.toMatch(/selected=10/);
    });
    // Search is preserved; status/page defaults remain.
    expect(window.location.search).toMatch(/search=/);

    await waitFor(() => {
      expect(screen.getByTestId('recipient-detail-grade')).toHaveTextContent('1등급');
      expect(screen.getByTestId('recipient-detail-copay')).toHaveTextContent('20%');
    });
    expect(screen.getByTestId('recipient-detail-grade')).not.toHaveTextContent('3등급');
    expect(screen.getByTestId('recipient-detail-copay')).not.toHaveTextContent('15%');
    expect(screen.getByTestId('recipient-selected-name')).toHaveTextContent('새페이지수급');
  });
});

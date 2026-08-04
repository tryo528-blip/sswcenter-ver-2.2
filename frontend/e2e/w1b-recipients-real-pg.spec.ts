import { expect, test, type APIRequestContext, type Page } from 'playwright/test';

test.use({
  trace: 'off',
  video: 'off',
  screenshot: 'off',
});

type JsonRecord = Record<string, unknown>;

type BrowserApiResult = {
  body: unknown;
  ok: boolean;
  raw: string;
  status: number;
};

type BrowserApiCall = {
  data?: JsonRecord;
  method?: string;
  path: string;
};

type RequestCapture = {
  body: unknown;
  method: string;
  url: string;
};

type PageErrorCounter = {
  count: number;
};

const EXPECTED_PROJECTS = new Set([
  'chromium-1440x1000',
  'chromium-1440x900',
  'chromium-1366x768',
]);

const API_INTERNAL_LEAK_PATTERN =
  /(?:sqlalchemy|traceback|internalerror|dsn|postgres(?:ql)?|password|secret|stack trace|exception in thread)/i;
const LEGACY_PUBLIC_KEY_PATTERN =
  /(?:legacy_recipient_key|legacy_attachment_key|source_system_code|payer_type|\bSELF\b|\bPRIMARY_GUARDIAN\b)/i;
const PAYER_GUARDIAN_KEY_PATTERN = /(?:payer_type|guardian_id)/i;

function asRecord(value: unknown): JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as JsonRecord)
    : {};
}

function responseItems(value: unknown, marker: string): JsonRecord[] {
  const items = asRecord(value).items;
  expect(Array.isArray(items), marker).toBe(true);
  return (items as unknown[]).map((item) => asRecord(item));
}

function parseJson(raw: string): unknown {
  try {
    return raw ? (JSON.parse(raw) as unknown) : null;
  } catch {
    return null;
  }
}

function numberField(value: unknown, field: string, marker: string): number {
  const candidate = asRecord(value)[field];
  const parsed = typeof candidate === 'number' ? candidate : Number(candidate);
  expect(Number.isSafeInteger(parsed) && parsed > 0, marker).toBe(true);
  return parsed;
}

function stringField(value: unknown, field: string, marker: string): string {
  const candidate = asRecord(value)[field];
  expect(typeof candidate === 'string' && candidate.length > 0, marker).toBe(true);
  return String(candidate);
}

function errorCode(value: unknown): string | undefined {
  const body = asRecord(value);
  const error = asRecord(body.error);
  const code = error.code ?? asRecord(body.detail).code;
  return typeof code === 'string' ? code : undefined;
}

function errorDetails(value: unknown): JsonRecord {
  return asRecord(asRecord(value).details);
}

function escapedId(id: number): string {
  return encodeURIComponent(String(id));
}

function recipientPath(id: number): string {
  return `/api/v1/recipients/${escapedId(id)}`;
}

function guardianCollectionPath(id: number): string {
  return `${recipientPath(id)}/guardians`;
}

function primaryCollectionPath(id: number): string {
  return `${recipientPath(id)}/primary-guardian-periods`;
}

function payerCollectionPath(id: number): string {
  return `${recipientPath(id)}/payer-snapshots`;
}

function buildRunKey(testInfo: { project: { name: string }; repeatEachIndex: number }): string {
  const project = testInfo.project.name.replace(/[^A-Za-z0-9]+/g, '-');
  return `W1B-${project}-${testInfo.repeatEachIndex}-${Date.now().toString(36)}`;
}

function requestBody(request: { postData(): string | null }): unknown {
  const raw = request.postData();
  return raw ? parseJson(raw) : null;
}

function findRequest(
  captures: RequestCapture[],
  predicate: (capture: RequestCapture) => boolean,
): RequestCapture | undefined {
  return [...captures].reverse().find(predicate);
}

function countCapturedRequests(captures: RequestCapture[], path: string, method: string): number {
  return captures.filter((capture) => {
    try {
      return new URL(capture.url).pathname === path && capture.method === method;
    } catch {
      return false;
    }
  }).length;
}

function assertNoKeys(value: unknown, pattern: RegExp, marker: string): void {
  const text = JSON.stringify(value) ?? '';
  expect(pattern.test(text), marker).toBe(false);
}

function assertNoSensitiveSurface(value: unknown, marker: string): void {
  assertNoKeys(value, API_INTERNAL_LEAK_PATTERN, marker);
  assertNoKeys(value, LEGACY_PUBLIC_KEY_PATTERN, `${marker}_LEGACY_KEYS`);
}

function normalizeUtcTimestamps(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => normalizeUtcTimestamps(item));
  if (typeof value !== 'object' || value === null) return value;

  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => {
      if (key.endsWith('_at_utc') && typeof item === 'string') {
        const epochMilliseconds = Date.parse(item);
        expect(Number.isNaN(epochMilliseconds), 'W1B_E2E_TIMESTAMP_NORMALIZATION_INVALID').toBe(false);
        return [key, new Date(epochMilliseconds).toISOString()];
      }
      return [key, normalizeUtcTimestamps(item)];
    }),
  );
}

async function browserApi(page: Page, call: BrowserApiCall): Promise<BrowserApiResult> {
  return page.evaluate(
    async ({ data, method = 'GET', path }) => {
      const headers = new Headers();
      if (data !== undefined) headers.set('Content-Type', 'application/json');
      if (['POST', 'PATCH', 'PUT', 'DELETE'].includes(method.toUpperCase())) {
        const match = document.cookie.match(/(?:^|; )\s*sswcenter_csrf\s*=\s*([^;]+)/);
        if (!match) {
          return {
            body: { error: { code: 'CSRF_COOKIE_MISSING' } },
            ok: false,
            raw: '',
            status: 0,
          };
        }
        try {
          const token = decodeURIComponent(match[1]);
          if (token) headers.set('X-CSRF-Token', token);
        } catch {
          return {
            body: { error: { code: 'CSRF_COOKIE_MALFORMED' } },
            ok: false,
            raw: '',
            status: 0,
          };
        }
      }
      const response = await fetch(path, {
        body: data === undefined ? undefined : JSON.stringify(data),
        credentials: 'include',
        headers,
        method,
      });
      const raw = await response.text();
      return {
        body: parseJson(raw),
        ok: response.ok,
        raw,
        status: response.status,
      };

      function parseJson(text: string): unknown {
        try {
          return text ? (JSON.parse(text) as unknown) : null;
        } catch {
          return null;
        }
      }
    },
    call,
  );
}

async function browserApiParallel(page: Page, calls: BrowserApiCall[]): Promise<BrowserApiResult[]> {
  return page.evaluate(
    async (requestCalls) => {
      const csrfToken = (() => {
        const match = document.cookie.match(/(?:^|; )\s*sswcenter_csrf\s*=\s*([^;]+)/);
        if (!match) return null;
        try {
          return decodeURIComponent(match[1]);
        } catch {
          return null;
        }
      })();

      return Promise.all(
        requestCalls.map(async ({ data, method = 'GET', path }) => {
          const headers = new Headers();
          if (data !== undefined) headers.set('Content-Type', 'application/json');
          if (['POST', 'PATCH', 'PUT', 'DELETE'].includes(method.toUpperCase())) {
            if (csrfToken) headers.set('X-CSRF-Token', csrfToken);
          }
          const response = await fetch(path, {
            body: data === undefined ? undefined : JSON.stringify(data),
            credentials: 'include',
            headers,
            method,
          });
          const raw = await response.text();
          let body: unknown = null;
          try {
            body = raw ? (JSON.parse(raw) as unknown) : null;
          } catch {
            body = null;
          }
          return { body, ok: response.ok, raw, status: response.status };
        }),
      );
    },
    calls,
  );
}

async function installDomLeakObserver(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const install = () => {
      const target = document.documentElement;
      if (!target) return;
      const win = window as unknown as { __w1bDomSurfaces?: string[] };
      win.__w1bDomSurfaces = [];
      const capture = () => {
        if (document.body) win.__w1bDomSurfaces?.push(document.body.innerText);
      };
      capture();
      new MutationObserver(capture).observe(target, {
        characterData: true,
        childList: true,
        subtree: true,
      });
    };
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', install, { once: true });
    } else {
      install();
    }
  });
}

async function snapshotDomAcrossNavigations(
  page: Page,
  domSurfacesAcrossNavigations: string[],
  urlSurfaces: string[],
  marker: string,
): Promise<void> {
  let snapshot: { dom: string[] | null; url: string };
  try {
    snapshot = await page.evaluate(() => {
      const win = window as unknown as { __w1bDomSurfaces?: unknown };
      const surfaces = win.__w1bDomSurfaces;
      return {
        dom: Array.isArray(surfaces)
          ? surfaces.filter((surface): surface is string => typeof surface === 'string')
          : null,
        url: window.location.href,
      };
    });
  } catch {
    expect.soft(false, `${marker}_OBSERVER_UNREADABLE`).toBe(true);
    return;
  }
  expect.soft(Array.isArray(snapshot.dom), `${marker}_OBSERVER_MISSING`).toBe(true);
  expect.soft(snapshot.dom?.length ?? 0, `${marker}_OBSERVER_EMPTY`).toBeGreaterThan(0);
  if (snapshot.dom) domSurfacesAcrossNavigations.push(...snapshot.dom);
  urlSurfaces.push(snapshot.url);
}

async function bootstrapIfRequired(
  request: APIRequestContext,
  pin: string,
  runKey: string,
  responseSurfaces: string[],
): Promise<void> {
  const status = await request.get('/api/bootstrap/status');
  const statusRaw = await status.text();
  responseSurfaces.push(statusRaw);
  expect(status.ok(), 'W1B_E2E_BOOTSTRAP_STATUS_FAILED').toBe(true);
  const statusBody = asRecord(parseJson(statusRaw));
  if (statusBody.bootstrap_required !== true) return;

  const bootstrap = await request.post('/api/bootstrap', {
    data: {
      admin_name: `${runKey} synthetic admin`,
      birth_date: '1980-01-01',
      center_name: `${runKey} synthetic center`,
      pin,
      sex_code: 'MALE',
      start_date: '2025-01-01',
    },
  });
  const bootstrapRaw = await bootstrap.text();
  responseSurfaces.push(bootstrapRaw);
  expect(bootstrap.ok(), 'W1B_E2E_BOOTSTRAP_FAILED').toBe(true);
}

async function loginInBrowser(page: Page, pin: string, pageErrors: PageErrorCounter): Promise<void> {
  await page.goto('/recipients');
  const authLoading = page.getByTestId('auth-loading');
  await expect(authLoading, 'W1B_E2E_AUTH_LOADING_STUCK').toBeHidden();
  await expect(page.getByTestId('bootstrap-container'), 'W1B_E2E_BOOTSTRAP_FORM_UNEXPECTED').toBeHidden();
  const loginContainer = page.getByTestId('login-container');
  if ((await loginContainer.count()) > 0 && (await loginContainer.first().isVisible())) {
    const loginResponsePromise = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === '/api/auth/login' &&
        response.request().method() === 'POST',
    );
    await page.getByTestId('login-pin-input').fill(pin);
    const legacyLoginSubmit = page.getByTestId('login-submit-btn');
    if (await legacyLoginSubmit.count()) await legacyLoginSubmit.click();
    const loginResponse = await loginResponsePromise;
    expect(loginResponse.ok(), 'W1B_E2E_LOGIN_REQUEST_FAILED').toBe(true);
    await expect(authLoading, 'W1B_E2E_AUTH_LOADING_STUCK').toBeHidden();
    await expect(loginContainer, 'W1B_E2E_LOGIN_FORM_STILL_VISIBLE').toBeHidden();
  }
  expect(pageErrors.count, 'W1B_E2E_PAGE_RUNTIME_ERROR').toBe(0);
  await expect(page.getByTestId('page-recipients'), 'W1B_E2E_RECIPIENT_ROUTE_MISSING').toBeVisible();
}

async function createRecipientViaUi(
  page: Page,
  name: string,
  requestCaptures: RequestCapture[],
  responseSurfaces: string[],
): Promise<JsonRecord> {
  const form = page.getByTestId('recipient-create-form');
  if (!(await form.isVisible())) {
    await page.getByTestId('recipient-create-toggle').click();
  }
  await expect(form, 'W1B_E2E_RECIPIENT_CREATE_FORM_MISSING').toBeVisible();
  await page.getByTestId('recipient-name-input').fill(name);
  await page.getByTestId('recipient-birth-date-input').fill('2000-01-01');
  await page.getByTestId('recipient-sex-code-select').selectOption('MALE');
  await page.getByTestId('recipient-postal-code-input').fill('W1B-POSTAL');
  await page.getByTestId('recipient-address-input').fill(`${name} address`);
  await page.getByTestId('recipient-home-phone-input').fill('010-1000-0001');
  await page.getByTestId('recipient-mobile-phone-input').fill('010-1000-0002');

  const responsePromise = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === '/api/v1/recipients' &&
      response.request().method() === 'POST',
  );
  await page.getByTestId('recipient-submit-button').click();
  const response = await responsePromise;
  const raw = await response.text();
  responseSurfaces.push(raw);
  expect(response.status(), 'W1B_E2E_RECIPIENT_CREATE_STATUS').toBe(201);

  const body = asRecord(parseJson(raw));
  expect(body.recipient_no, 'W1B_E2E_RECIPIENT_NO_MUST_BE_NULL').toBeNull();
  expect(body.home_phone, 'W1B_E2E_RECIPIENT_HOME_PHONE_READBACK').toBe('010-1000-0001');
  expect(body.mobile_phone, 'W1B_E2E_RECIPIENT_MOBILE_PHONE_READBACK').toBe('010-1000-0002');
  const captured = findRequest(
    requestCaptures,
    (item) => new URL(item.url).pathname === '/api/v1/recipients' && item.method === 'POST',
  );
  expect(captured, 'W1B_E2E_RECIPIENT_CREATE_REQUEST_MISSING').toBeTruthy();
  expect('recipient_no' in asRecord(captured?.body), 'W1B_E2E_RECIPIENT_NO_INPUT_FORBIDDEN').toBe(false);
  return body;
}

async function createBulkRecipients(
  page: Page,
  runKey: string,
  requestCaptures: RequestCapture[],
  responseSurfaces: string[],
): Promise<void> {
  const total = 102;
  const batchSize = 8;
  for (let offset = 0; offset < total; offset += batchSize) {
    const calls: BrowserApiCall[] = [];
    for (let index = offset; index < Math.min(offset + batchSize, total); index += 1) {
      calls.push({
        data: {
          address: null,
          birth_date: '2000-01-01',
          home_phone: null,
          memo: null,
          mobile_phone: null,
          name: `${runKey}-ROW-${String(index).padStart(3, '0')}`,
          postal_code: null,
          sex_code: index % 2 === 0 ? 'MALE' : 'FEMALE',
        },
        method: 'POST',
        path: '/api/v1/recipients',
      });
    }
    const results = await browserApiParallel(page, calls);
    results.forEach((result, index) => {
      responseSurfaces.push(result.raw);
      expect(result.status, `W1B_E2E_BULK_RECIPIENT_CREATE_${offset + index}`).toBe(201);
      expect(asRecord(result.body).recipient_no, 'W1B_E2E_BULK_RECIPIENT_NO_NULL').toBeNull();
    });
  }
  const listPosts = requestCaptures.filter(
    (item) => new URL(item.url).pathname === '/api/v1/recipients' && item.method === 'POST',
  );
  expect(listPosts.length, 'W1B_E2E_BULK_RECIPIENT_REQUEST_COUNT').toBeGreaterThanOrEqual(total);
}

async function expectRecipientReadback(page: Page, recipientId: number, name: string): Promise<JsonRecord> {
  const detail = await browserApi(page, { path: recipientPath(recipientId) });
  expect(detail.status, 'W1B_E2E_RECIPIENT_DETAIL_STATUS').toBe(200);
  expect(asRecord(detail.body).name, 'W1B_E2E_RECIPIENT_DETAIL_NAME').toBe(name);
  expect(asRecord(detail.body).home_phone, 'W1B_E2E_RECIPIENT_DETAIL_HOME_PHONE').toBe('010-1000-0001');
  expect(asRecord(detail.body).mobile_phone, 'W1B_E2E_RECIPIENT_DETAIL_MOBILE_PHONE').toBe('010-1000-0002');
  return asRecord(detail.body);
}

async function expectApiSuccess(
  result: BrowserApiResult,
  status: number,
  marker: string,
): Promise<JsonRecord> {
  expect(result.status, `${marker}_STATUS`).toBe(status);
  expect(result.ok, `${marker}_OK`).toBe(true);
  return asRecord(result.body);
}

async function expectApiConflict(
  result: BrowserApiResult,
  code: string,
  marker: string,
): Promise<JsonRecord> {
  expect(result.status, `${marker}_STATUS`).toBe(409);
  expect(errorCode(result.body), `${marker}_CODE`).toBe(code);
  return asRecord(result.body);
}

async function createGuardians(
  page: Page,
  recipientId: number,
  responseSurfaces: string[],
): Promise<{ guardianA: JsonRecord; guardianB: JsonRecord }> {
  const guardianAResult = await browserApi(page, {
    data: {
      address: null,
      name: `W1B guardian A ${recipientId}`,
      phone: null,
      relationship_text: null,
    },
    method: 'POST',
    path: guardianCollectionPath(recipientId),
  });
  responseSurfaces.push(guardianAResult.raw);
  const guardianA = await expectApiSuccess(guardianAResult, 201, 'W1B_E2E_GUARDIAN_A_CREATE');

  const guardianBResult = await browserApi(page, {
    data: {
      address: `W1B guardian B address ${recipientId}`,
      name: `W1B guardian B ${recipientId}`,
      phone: '010-2000-0003',
      relationship_text: 'parent',
    },
    method: 'POST',
    path: guardianCollectionPath(recipientId),
  });
  responseSurfaces.push(guardianBResult.raw);
  const guardianB = await expectApiSuccess(guardianBResult, 201, 'W1B_E2E_GUARDIAN_B_CREATE');

  const guardianBId = numberField(guardianB, 'id', 'W1B_E2E_GUARDIAN_B_ID');
  const guardianBVersion = numberField(guardianB, 'row_version', 'W1B_E2E_GUARDIAN_B_VERSION');
  const updateResult = await browserApi(page, {
    data: {
      address: `W1B guardian B updated address ${recipientId}`,
      expected_row_version: guardianBVersion,
      name: `W1B guardian B updated ${recipientId}`,
      phone: '010-2000-0099',
      relationship_text: 'parent-updated',
    },
    method: 'PATCH',
    path: `${guardianCollectionPath(recipientId)}/${escapedId(guardianBId)}`,
  });
  responseSurfaces.push(updateResult.raw);
  const updatedGuardianB = await expectApiSuccess(updateResult, 200, 'W1B_E2E_GUARDIAN_B_UPDATE');

  const listResult = await browserApi(page, { path: guardianCollectionPath(recipientId) });
  responseSurfaces.push(listResult.raw);
  const guardians = asRecord(listResult.body).items;
  expect(Array.isArray(guardians), 'W1B_E2E_GUARDIAN_LIST_SHAPE').toBe(true);
  expect((guardians as unknown[]).length, 'W1B_E2E_GUARDIAN_COUNT').toBe(2);
  expect(JSON.stringify(guardians), 'W1B_E2E_GUARDIAN_OPTIONAL_READBACK').toContain('010-2000-0099');
  expect(JSON.stringify(guardians), 'W1B_E2E_GUARDIAN_RELATIONSHIP_READBACK').toContain('parent-updated');
  expect('birth_date' in asRecord(updatedGuardianB), 'W1B_E2E_GUARDIAN_BIRTH_DATE_FORBIDDEN').toBe(false);
  expect('sex_code' in asRecord(updatedGuardianB), 'W1B_E2E_GUARDIAN_SEX_FORBIDDEN').toBe(false);
  return { guardianA, guardianB: updatedGuardianB };
}

async function exercisePrimaryHistory(
  page: Page,
  recipientId: number,
  guardianA: JsonRecord,
  guardianB: JsonRecord,
  responseSurfaces: string[],
): Promise<void> {
  const guardianAId = numberField(guardianA, 'id', 'W1B_E2E_PRIMARY_GUARDIAN_A_ID');
  const guardianBId = numberField(guardianB, 'id', 'W1B_E2E_PRIMARY_GUARDIAN_B_ID');

  const finitePeriodResult = await browserApi(page, {
    data: { end_date: '2026-02-28', guardian_id: guardianAId, start_date: '2026-01-01' },
    method: 'POST',
    path: primaryCollectionPath(recipientId),
  });
  responseSurfaces.push(finitePeriodResult.raw);
  await expectApiSuccess(finitePeriodResult, 201, 'W1B_E2E_PRIMARY_FINITE_CREATE');

  const concurrent = await browserApiParallel(page, [
    {
      data: { end_date: null, guardian_id: guardianAId, start_date: '2026-03-01' },
      method: 'POST',
      path: primaryCollectionPath(recipientId),
    },
    {
      data: { end_date: null, guardian_id: guardianBId, start_date: '2026-03-01' },
      method: 'POST',
      path: primaryCollectionPath(recipientId),
    },
  ]);
  concurrent.forEach((result) => responseSurfaces.push(result.raw));
  const created = concurrent.filter((result) => result.status === 201);
  const conflicts = concurrent.filter((result) => result.status === 409);
  expect(created.length, 'W1B_E2E_PRIMARY_CONCURRENT_ONE_SUCCESS').toBe(1);
  expect(conflicts.length, 'W1B_E2E_PRIMARY_CONCURRENT_ONE_CONFLICT').toBe(1);
  await expectApiConflict(
    conflicts[0],
    'PRIMARY_GUARDIAN_PERIOD_CONFLICT',
    'W1B_E2E_PRIMARY_CONCURRENT_CONFLICT',
  );

  const current = asRecord(created[0].body);
  const currentId = numberField(current, 'id', 'W1B_E2E_PRIMARY_CURRENT_ID');
  const currentVersion = numberField(current, 'row_version', 'W1B_E2E_PRIMARY_CURRENT_VERSION');
  const replacementResult = await browserApi(page, {
    data: {
      end_date: null,
      expected_row_version: currentVersion,
      guardian_id: guardianBId,
      start_date: '2026-04-01',
    },
    method: 'POST',
    path: `${primaryCollectionPath(recipientId)}/${escapedId(currentId)}/replacements`,
  });
  responseSurfaces.push(replacementResult.raw);
  const replacement = await expectApiSuccess(replacementResult, 201, 'W1B_E2E_PRIMARY_REPLACE');
  const original = asRecord(replacement.original);
  const newPeriod = asRecord(replacement.replacement);
  expect(original.invalidated_at_utc, 'W1B_E2E_PRIMARY_ORIGINAL_INVALIDATED').not.toBeNull();
  expect(original.replacement_primary_guardian_period_id, 'W1B_E2E_PRIMARY_LINKAGE').toBe(
    newPeriod.id,
  );

  const staleResult = await browserApi(page, {
    data: {
      end_date: null,
      expected_row_version: currentVersion,
      guardian_id: guardianAId,
      start_date: '2026-05-01',
    },
    method: 'POST',
    path: `${primaryCollectionPath(recipientId)}/${escapedId(currentId)}/replacements`,
  });
  responseSurfaces.push(staleResult.raw);
  const staleBody = await expectApiConflict(staleResult, 'ROW_VERSION_CONFLICT', 'W1B_E2E_PRIMARY_STALE');
  expect(errorDetails(staleBody).current_row_version, 'W1B_E2E_PRIMARY_STALE_VERSION_DETAIL').toBeGreaterThan(
    currentVersion,
  );

  const replacementId = numberField(newPeriod, 'id', 'W1B_E2E_PRIMARY_REPLACEMENT_ID');
  const replacementVersion = numberField(newPeriod, 'row_version', 'W1B_E2E_PRIMARY_REPLACEMENT_VERSION');
  const invalidateResult = await browserApi(page, {
    data: { expected_row_version: replacementVersion },
    method: 'POST',
    path: `${primaryCollectionPath(recipientId)}/${escapedId(replacementId)}/invalidate`,
  });
  responseSurfaces.push(invalidateResult.raw);
  const invalidated = await expectApiSuccess(invalidateResult, 200, 'W1B_E2E_PRIMARY_INVALIDATE');
  expect(invalidated.invalidated_at_utc, 'W1B_E2E_PRIMARY_INVALIDATED_AT').not.toBeNull();

  const historyResult = await browserApi(page, { path: primaryCollectionPath(recipientId) });
  responseSurfaces.push(historyResult.raw);
  const history = asRecord(historyResult.body).items;
  expect(Array.isArray(history), 'W1B_E2E_PRIMARY_HISTORY_SHAPE').toBe(true);
  expect((history as unknown[]).length, 'W1B_E2E_PRIMARY_HISTORY_COUNT').toBeGreaterThanOrEqual(3);
  expect(JSON.stringify(history), 'W1B_E2E_PRIMARY_HISTORY_LINK').toContain(String(newPeriod.id));
}

async function exercisePayerHistory(
  page: Page,
  recipientId: number,
  guardianId: number,
  responseSurfaces: string[],
): Promise<void> {
  const firstResult = await browserApi(page, {
    data: {
      address: null,
      end_date: null,
      name: `W1B payer null ${recipientId}`,
      phone: null,
      relationship_text: null,
      start_date: '2026-01-01',
    },
    method: 'POST',
    path: payerCollectionPath(recipientId),
  });
  responseSurfaces.push(firstResult.raw);
  const first = await expectApiSuccess(firstResult, 201, 'W1B_E2E_PAYER_NULL_CREATE');
  expect(first.phone, 'W1B_E2E_PAYER_NULL_PHONE').toBeNull();
  expect(first.address, 'W1B_E2E_PAYER_NULL_ADDRESS').toBeNull();
  expect(first.relationship_text, 'W1B_E2E_PAYER_NULL_RELATIONSHIP').toBeNull();
  assertNoKeys(first, PAYER_GUARDIAN_KEY_PATTERN, 'W1B_E2E_PAYER_NULL_FORBIDDEN_FK');

  const firstId = numberField(first, 'id', 'W1B_E2E_PAYER_FIRST_ID');
  const firstVersion = numberField(first, 'row_version', 'W1B_E2E_PAYER_FIRST_VERSION');
  const conflictResult = await browserApi(page, {
    data: {
      address: null,
      end_date: null,
      name: `W1B payer conflict ${recipientId}`,
      phone: null,
      relationship_text: null,
      start_date: '2026-02-01',
    },
    method: 'POST',
    path: payerCollectionPath(recipientId),
  });
  responseSurfaces.push(conflictResult.raw);
  await expectApiConflict(conflictResult, 'CURRENT_PAYER_CONFLICT', 'W1B_E2E_PAYER_CURRENT_CONFLICT');

  const replacementResult = await browserApi(page, {
    data: {
      address: `W1B payer address ${recipientId}`,
      end_date: null,
      expected_row_version: firstVersion,
      name: `W1B payer populated ${recipientId}`,
      phone: '010-3000-0004',
      relationship_text: 'guardian contact',
      start_date: '2026-03-01',
    },
    method: 'POST',
    path: `${payerCollectionPath(recipientId)}/${escapedId(firstId)}/replacements`,
  });
  responseSurfaces.push(replacementResult.raw);
  const replacement = await expectApiSuccess(replacementResult, 201, 'W1B_E2E_PAYER_REPLACE');
  const original = asRecord(replacement.original);
  const current = asRecord(replacement.replacement);
  expect(original.invalidated_at_utc, 'W1B_E2E_PAYER_ORIGINAL_INVALIDATED').not.toBeNull();
  expect(original.replacement_payer_snapshot_id, 'W1B_E2E_PAYER_LINKAGE').toBe(current.id);
  expect(current.phone, 'W1B_E2E_PAYER_PHONE_READBACK').toBe('010-3000-0004');
  expect(current.address, 'W1B_E2E_PAYER_ADDRESS_READBACK').toBe(`W1B payer address ${recipientId}`);
  expect(current.relationship_text, 'W1B_E2E_PAYER_RELATIONSHIP_READBACK').toBe('guardian contact');
  assertNoKeys(replacement, PAYER_GUARDIAN_KEY_PATTERN, 'W1B_E2E_PAYER_REPLACEMENT_FORBIDDEN_FK');

  const staleResult = await browserApi(page, {
    data: {
      address: null,
      end_date: null,
      expected_row_version: firstVersion,
      name: `W1B payer stale ${recipientId}`,
      phone: null,
      relationship_text: null,
      start_date: '2026-05-01',
    },
    method: 'POST',
    path: `${payerCollectionPath(recipientId)}/${escapedId(firstId)}/replacements`,
  });
  responseSurfaces.push(staleResult.raw);
  await expectApiConflict(staleResult, 'ROW_VERSION_CONFLICT', 'W1B_E2E_PAYER_STALE');

  const currentId = numberField(current, 'id', 'W1B_E2E_PAYER_CURRENT_ID');
  const currentVersion = numberField(current, 'row_version', 'W1B_E2E_PAYER_CURRENT_VERSION');
  const invalidateResult = await browserApi(page, {
    data: { expected_row_version: currentVersion },
    method: 'POST',
    path: `${payerCollectionPath(recipientId)}/${escapedId(currentId)}/invalidate`,
  });
  responseSurfaces.push(invalidateResult.raw);
  await expectApiSuccess(invalidateResult, 200, 'W1B_E2E_PAYER_INVALIDATE');

  const recreateResult = await browserApi(page, {
    data: {
      address: null,
      end_date: null,
      name: `W1B payer recreated ${recipientId}`,
      phone: null,
      relationship_text: null,
      start_date: '2026-06-01',
    },
    method: 'POST',
    path: payerCollectionPath(recipientId),
  });
  responseSurfaces.push(recreateResult.raw);
  const recreated = await expectApiSuccess(recreateResult, 201, 'W1B_E2E_PAYER_RECREATE');
  expect(recreated.invalidated_at_utc, 'W1B_E2E_PAYER_RECREATE_CURRENT').toBeNull();

  const payerListBefore = await browserApi(page, { path: payerCollectionPath(recipientId) });
  responseSurfaces.push(payerListBefore.raw);
  const payerBefore = normalizeUtcTimestamps(payerListBefore.body);
  expect(JSON.stringify(payerBefore), 'W1B_E2E_PAYER_GUARDIAN_INDEPENDENT_BASELINE').toContain(
    'W1B payer recreated',
  );

  const guardianMutation = await browserApi(page, {
    data: {
      address: `W1B guardian after payer ${recipientId}`,
      expected_row_version: 1,
      name: `W1B guardian after payer ${recipientId}`,
      phone: '010-3999-9999',
      relationship_text: 'independent',
    },
    method: 'PATCH',
    path: `${guardianCollectionPath(recipientId)}/${escapedId(guardianId)}`,
  });
  responseSurfaces.push(guardianMutation.raw);
  expect(guardianMutation.status, 'W1B_E2E_PAYER_GUARDIAN_MUTATION_STATUS').toBe(200);

  const payerListAfter = await browserApi(page, { path: payerCollectionPath(recipientId) });
  responseSurfaces.push(payerListAfter.raw);
  expect(
    normalizeUtcTimestamps(payerListAfter.body),
    'W1B_E2E_PAYER_GUARDIAN_INDEPENDENT_AFTER',
  ).toEqual(payerBefore);
  assertNoKeys(payerListAfter.body, PAYER_GUARDIAN_KEY_PATTERN, 'W1B_E2E_PAYER_LIST_FORBIDDEN_FK');
}

async function exerciseInclusiveEndUiBoundaries(
  page: Page,
  recipientId: number,
  guardianAId: number,
  guardianBId: number,
  requestCaptures: RequestCapture[],
  responseSurfaces: string[],
): Promise<void> {
  const primaryPath = primaryCollectionPath(recipientId);
  const payerPath = payerCollectionPath(recipientId);
  const primaryForm = page.getByTestId('recipient-primary-guardian-form');
  const primaryHistory = page.getByTestId('recipient-primary-guardian-history');
  const primarySelect = page.getByTestId('recipient-primary-guardian-select');
  const primaryStart = page.getByTestId('recipient-primary-start-date-input');
  const primaryEnd = page.getByTestId('recipient-primary-end-date-input');
  const primarySubmit = primaryForm.locator('button[type="submit"]');
  const payerForm = page.getByTestId('recipient-payer-form');
  const payerHistory = page.getByTestId('recipient-payer-snapshot-section');
  const payerName = page.getByTestId('recipient-payer-name-input');
  const payerPhone = page.getByTestId('recipient-payer-phone-input');
  const payerRelationship = page.getByTestId('recipient-payer-relationship-input');
  const payerAddress = page.getByTestId('recipient-payer-address-input');
  const payerStart = page.getByTestId('recipient-payer-start-date-input');
  const payerEnd = page.getByTestId('recipient-payer-end-date-input');
  const payerSubmit = payerForm.locator('button[type="submit"]');

  await page.reload();
  await expect(page.getByTestId('page-recipients'), 'W1B_E2E_BOUNDARY_RELOAD_PAGE').toBeVisible();
  await expect(page.getByTestId('recipient-detail-workspace'), 'W1B_E2E_BOUNDARY_RELOAD_DETAIL').toBeVisible();
  await expect(primaryForm, 'W1B_E2E_PRIMARY_BOUNDARY_FORM_READY').toBeVisible();
  await expect(primarySelect.locator('option'), 'W1B_E2E_PRIMARY_BOUNDARY_GUARDIANS_READY').toHaveCount(3);
  await expect(payerForm, 'W1B_E2E_PAYER_BOUNDARY_FORM_READY').toBeVisible();

  await primarySelect.selectOption(String(guardianAId));
  await primaryStart.fill('2024-04-01');
  await primaryEnd.fill('2024-04-01');
  const primaryDayBefore = countCapturedRequests(requestCaptures, primaryPath, 'POST');
  const primaryDayResponsePromise = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === primaryPath && response.request().method() === 'POST',
  );
  await primarySubmit.click();
  const primaryDayResponse = await primaryDayResponsePromise;
  const primaryDayRaw = await primaryDayResponse.text();
  responseSurfaces.push(primaryDayRaw);
  expect(primaryDayResponse.status(), 'W1B_E2E_PRIMARY_BOUNDARY_DAY_STATUS').toBe(201);
  expect(
    countCapturedRequests(requestCaptures, primaryPath, 'POST'),
    'W1B_E2E_PRIMARY_BOUNDARY_DAY_POST_COUNT',
  ).toBe(primaryDayBefore + 1);
  const primaryDayBody = asRecord(parseJson(primaryDayRaw));
  expect(primaryDayBody.start_date, 'W1B_E2E_PRIMARY_BOUNDARY_DAY_START').toBe('2024-04-01');
  expect(primaryDayBody.end_date, 'W1B_E2E_PRIMARY_BOUNDARY_DAY_END').toBe('2024-04-01');
  await expect(primaryHistory, 'W1B_E2E_PRIMARY_BOUNDARY_DAY_UI_READBACK').toContainText('2024-04-01');

  const primaryDayReadback = await browserApi(page, { path: primaryPath });
  responseSurfaces.push(primaryDayReadback.raw);
  expect(primaryDayReadback.status, 'W1B_E2E_PRIMARY_BOUNDARY_DAY_READBACK_STATUS').toBe(200);
  const primaryDayRows = responseItems(primaryDayReadback.body, 'W1B_E2E_PRIMARY_BOUNDARY_DAY_READBACK_SHAPE');
  expect(
    primaryDayRows.some(
      (period) =>
        period.start_date === '2024-04-01' &&
        period.end_date === '2024-04-01' &&
        period.invalidated_at_utc === null,
    ),
    'W1B_E2E_PRIMARY_BOUNDARY_DAY_READBACK',
  ).toBe(true);

  await primarySelect.selectOption(String(guardianBId));
  await primaryStart.fill('2024-04-01');
  await primaryEnd.fill('2024-04-01');
  const primaryOverlapBefore = countCapturedRequests(requestCaptures, primaryPath, 'POST');
  await primarySubmit.click();
  await expect(
    primaryForm.locator('.recipient-inline-error'),
    'W1B_E2E_PRIMARY_BOUNDARY_OVERLAP_ERROR',
  ).toBeVisible();
  expect(
    countCapturedRequests(requestCaptures, primaryPath, 'POST'),
    'W1B_E2E_PRIMARY_BOUNDARY_OVERLAP_NO_POST',
  ).toBe(primaryOverlapBefore);

  await primarySelect.selectOption(String(guardianBId));
  await primaryStart.fill('2024-04-02');
  await primaryEnd.fill('2024-04-02');
  const primaryAdjacentBefore = countCapturedRequests(requestCaptures, primaryPath, 'POST');
  const primaryAdjacentResponsePromise = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === primaryPath && response.request().method() === 'POST',
  );
  await primarySubmit.click();
  const primaryAdjacentResponse = await primaryAdjacentResponsePromise;
  const primaryAdjacentRaw = await primaryAdjacentResponse.text();
  responseSurfaces.push(primaryAdjacentRaw);
  expect(primaryAdjacentResponse.status(), 'W1B_E2E_PRIMARY_BOUNDARY_ADJACENT_STATUS').toBe(201);
  expect(
    countCapturedRequests(requestCaptures, primaryPath, 'POST'),
    'W1B_E2E_PRIMARY_BOUNDARY_ADJACENT_POST_COUNT',
  ).toBe(primaryAdjacentBefore + 1);
  const primaryAdjacentBody = asRecord(parseJson(primaryAdjacentRaw));
  expect(primaryAdjacentBody.start_date, 'W1B_E2E_PRIMARY_BOUNDARY_ADJACENT_START').toBe('2024-04-02');
  expect(primaryAdjacentBody.end_date, 'W1B_E2E_PRIMARY_BOUNDARY_ADJACENT_END').toBe('2024-04-02');
  await expect(primaryHistory, 'W1B_E2E_PRIMARY_BOUNDARY_ADJACENT_UI_READBACK').toContainText('2024-04-02');

  const primaryBoundaryReadback = await browserApi(page, { path: primaryPath });
  responseSurfaces.push(primaryBoundaryReadback.raw);
  expect(primaryBoundaryReadback.status, 'W1B_E2E_PRIMARY_BOUNDARY_READBACK_STATUS').toBe(200);
  const primaryBoundaryRows = responseItems(
    primaryBoundaryReadback.body,
    'W1B_E2E_PRIMARY_BOUNDARY_READBACK_SHAPE',
  );
  const activePrimaryBoundaryRows = primaryBoundaryRows.filter(
    (period) =>
      (period.start_date === '2024-04-01' || period.start_date === '2024-04-02') &&
      period.end_date === period.start_date &&
      period.invalidated_at_utc === null,
  );
  expect(activePrimaryBoundaryRows, 'W1B_E2E_PRIMARY_BOUNDARY_ACTIVE_ROWS').toHaveLength(2);
  for (const period of activePrimaryBoundaryRows) {
    const periodId = numberField(period, 'id', 'W1B_E2E_PRIMARY_BOUNDARY_CLEANUP_ID');
    const periodVersion = numberField(period, 'row_version', 'W1B_E2E_PRIMARY_BOUNDARY_CLEANUP_VERSION');
    const invalidation = await browserApi(page, {
      data: { expected_row_version: periodVersion },
      method: 'POST',
      path: `${primaryPath}/${escapedId(periodId)}/invalidate`,
    });
    responseSurfaces.push(invalidation.raw);
    const invalidated = await expectApiSuccess(
      invalidation,
      200,
      'W1B_E2E_PRIMARY_BOUNDARY_CLEANUP_INVALIDATE',
    );
    expect(
      invalidated.invalidated_at_utc,
      'W1B_E2E_PRIMARY_BOUNDARY_CLEANUP_INVALIDATED_AT',
    ).not.toBeNull();
  }

  const primaryAfterCleanup = await browserApi(page, { path: primaryPath });
  responseSurfaces.push(primaryAfterCleanup.raw);
  const primaryAfterCleanupRows = responseItems(
    primaryAfterCleanup.body,
    'W1B_E2E_PRIMARY_BOUNDARY_CLEANUP_READBACK_SHAPE',
  );
  expect(
    primaryAfterCleanupRows
      .filter((period) => period.start_date === '2024-04-01' || period.start_date === '2024-04-02')
      .every((period) => period.invalidated_at_utc !== null),
    'W1B_E2E_PRIMARY_BOUNDARY_CLEANUP_READBACK',
  ).toBe(true);

  await page.reload();
  await expect(page.getByTestId('page-recipients'), 'W1B_E2E_PAYER_BOUNDARY_RELOAD_PAGE').toBeVisible();
  await expect(payerForm, 'W1B_E2E_PAYER_BOUNDARY_FORM_AFTER_PRIMARY_CLEANUP').toBeVisible();
  await expect(payerPhone, 'W1B_E2E_PAYER_BOUNDARY_PHONE_EMPTY').toHaveValue('');
  await expect(payerRelationship, 'W1B_E2E_PAYER_BOUNDARY_RELATIONSHIP_EMPTY').toHaveValue('');
  await expect(payerAddress, 'W1B_E2E_PAYER_BOUNDARY_ADDRESS_EMPTY').toHaveValue('');

  await payerName.fill(`W1B payer boundary day ${recipientId}`);
  await payerStart.fill('2024-06-01');
  await payerEnd.fill('2024-06-01');
  const payerDayBefore = countCapturedRequests(requestCaptures, payerPath, 'POST');
  const payerDayResponsePromise = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === payerPath && response.request().method() === 'POST',
  );
  await payerSubmit.click();
  const payerDayResponse = await payerDayResponsePromise;
  const payerDayRaw = await payerDayResponse.text();
  responseSurfaces.push(payerDayRaw);
  expect(payerDayResponse.status(), 'W1B_E2E_PAYER_BOUNDARY_DAY_STATUS').toBe(201);
  expect(
    countCapturedRequests(requestCaptures, payerPath, 'POST'),
    'W1B_E2E_PAYER_BOUNDARY_DAY_POST_COUNT',
  ).toBe(payerDayBefore + 1);
  const payerDayBody = asRecord(parseJson(payerDayRaw));
  expect(payerDayBody.start_date, 'W1B_E2E_PAYER_BOUNDARY_DAY_START').toBe('2024-06-01');
  expect(payerDayBody.end_date, 'W1B_E2E_PAYER_BOUNDARY_DAY_END').toBe('2024-06-01');
  await expect(payerHistory, 'W1B_E2E_PAYER_BOUNDARY_DAY_UI_READBACK').toContainText('2024-06-01');

  const payerDayReadback = await browserApi(page, { path: payerPath });
  responseSurfaces.push(payerDayReadback.raw);
  expect(payerDayReadback.status, 'W1B_E2E_PAYER_BOUNDARY_DAY_READBACK_STATUS').toBe(200);
  const payerDayRows = responseItems(payerDayReadback.body, 'W1B_E2E_PAYER_BOUNDARY_DAY_READBACK_SHAPE');
  expect(
    payerDayRows.some(
      (snapshot) =>
        snapshot.start_date === '2024-06-01' &&
        snapshot.end_date === '2024-06-01' &&
        snapshot.invalidated_at_utc === null,
    ),
    'W1B_E2E_PAYER_BOUNDARY_DAY_READBACK',
  ).toBe(true);

  await payerName.fill(`W1B payer boundary overlap ${recipientId}`);
  await payerStart.fill('2024-06-01');
  await payerEnd.fill('2024-06-01');
  const payerOverlapBefore = countCapturedRequests(requestCaptures, payerPath, 'POST');
  await payerSubmit.click();
  await expect(
    payerForm.locator('.recipient-inline-error'),
    'W1B_E2E_PAYER_BOUNDARY_OVERLAP_ERROR',
  ).toBeVisible();
  expect(
    countCapturedRequests(requestCaptures, payerPath, 'POST'),
    'W1B_E2E_PAYER_BOUNDARY_OVERLAP_NO_POST',
  ).toBe(payerOverlapBefore);

  await payerName.fill(`W1B payer boundary adjacent ${recipientId}`);
  await payerStart.fill('2024-06-02');
  await payerEnd.fill('2024-06-02');
  const payerAdjacentBefore = countCapturedRequests(requestCaptures, payerPath, 'POST');
  const payerAdjacentResponsePromise = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === payerPath && response.request().method() === 'POST',
  );
  await payerSubmit.click();
  const payerAdjacentResponse = await payerAdjacentResponsePromise;
  const payerAdjacentRaw = await payerAdjacentResponse.text();
  responseSurfaces.push(payerAdjacentRaw);
  expect(payerAdjacentResponse.status(), 'W1B_E2E_PAYER_BOUNDARY_ADJACENT_STATUS').toBe(201);
  expect(
    countCapturedRequests(requestCaptures, payerPath, 'POST'),
    'W1B_E2E_PAYER_BOUNDARY_ADJACENT_POST_COUNT',
  ).toBe(payerAdjacentBefore + 1);
  const payerAdjacentBody = asRecord(parseJson(payerAdjacentRaw));
  expect(payerAdjacentBody.start_date, 'W1B_E2E_PAYER_BOUNDARY_ADJACENT_START').toBe('2024-06-02');
  expect(payerAdjacentBody.end_date, 'W1B_E2E_PAYER_BOUNDARY_ADJACENT_END').toBe('2024-06-02');
  await expect(payerHistory, 'W1B_E2E_PAYER_BOUNDARY_ADJACENT_UI_READBACK').toContainText('2024-06-02');

  const payerBoundaryReadback = await browserApi(page, { path: payerPath });
  responseSurfaces.push(payerBoundaryReadback.raw);
  expect(payerBoundaryReadback.status, 'W1B_E2E_PAYER_BOUNDARY_READBACK_STATUS').toBe(200);
  const payerBoundaryRows = responseItems(payerBoundaryReadback.body, 'W1B_E2E_PAYER_BOUNDARY_READBACK_SHAPE');
  const activePayerBoundaryRows = payerBoundaryRows.filter(
    (snapshot) =>
      (snapshot.start_date === '2024-06-01' || snapshot.start_date === '2024-06-02') &&
      snapshot.end_date === snapshot.start_date &&
      snapshot.invalidated_at_utc === null,
  );
  expect(activePayerBoundaryRows, 'W1B_E2E_PAYER_BOUNDARY_ACTIVE_ROWS').toHaveLength(2);
  for (const snapshot of activePayerBoundaryRows) {
    const snapshotId = numberField(snapshot, 'id', 'W1B_E2E_PAYER_BOUNDARY_CLEANUP_ID');
    const snapshotVersion = numberField(snapshot, 'row_version', 'W1B_E2E_PAYER_BOUNDARY_CLEANUP_VERSION');
    const invalidation = await browserApi(page, {
      data: { expected_row_version: snapshotVersion },
      method: 'POST',
      path: `${payerPath}/${escapedId(snapshotId)}/invalidate`,
    });
    responseSurfaces.push(invalidation.raw);
    const invalidated = await expectApiSuccess(
      invalidation,
      200,
      'W1B_E2E_PAYER_BOUNDARY_CLEANUP_INVALIDATE',
    );
    expect(
      invalidated.invalidated_at_utc,
      'W1B_E2E_PAYER_BOUNDARY_CLEANUP_INVALIDATED_AT',
    ).not.toBeNull();
  }

  const payerAfterCleanup = await browserApi(page, { path: payerPath });
  responseSurfaces.push(payerAfterCleanup.raw);
  const payerAfterCleanupRows = responseItems(
    payerAfterCleanup.body,
    'W1B_E2E_PAYER_BOUNDARY_CLEANUP_READBACK_SHAPE',
  );
  expect(
    payerAfterCleanupRows
      .filter((snapshot) => snapshot.start_date === '2024-06-01' || snapshot.start_date === '2024-06-02')
      .every((snapshot) => snapshot.invalidated_at_utc !== null),
    'W1B_E2E_PAYER_BOUNDARY_CLEANUP_READBACK',
  ).toBe(true);
  await page.reload();
  await expect(page.getByTestId('page-recipients'), 'W1B_E2E_BOUNDARY_FINAL_RELOAD_PAGE').toBeVisible();
  await expect(primaryForm, 'W1B_E2E_BOUNDARY_FINAL_PRIMARY_FORM').toBeVisible();
  await expect(payerForm, 'W1B_E2E_BOUNDARY_FINAL_PAYER_FORM').toBeVisible();
}

test.describe('W1B-F2 real PostgreSQL recipient GREEN contract', () => {
  test('runs one real API/PG scenario per configured viewport', async ({ page, request }, testInfo) => {
    expect(EXPECTED_PROJECTS.has(testInfo.project.name), 'W1B_E2E_VIEWPORT_PROJECT_MISSING').toBe(true);
    expect(process.env.SSWCENTER_W1B_REAL_PG, 'W1B_E2E_REAL_PG_HARNESS_REQUIRED').toBe('1');
    const syntheticPin = process.env.SSWCENTER_W1B_SYNTHETIC_PIN;
    expect(
      typeof syntheticPin === 'string' && /^[0-9]{6}$/.test(syntheticPin),
      'W1B_E2E_SYNTHETIC_PIN_ENV_REQUIRED',
    ).toBe(true);
    const pin = String(syntheticPin);
    const runKey = buildRunKey(testInfo);
    const requestCaptures: RequestCapture[] = [];
    const responseSurfaces: string[] = [];
    const responsePromises: Promise<void>[] = [];
    const domSurfacesAcrossNavigations: string[] = [];
    const urlSurfaces: string[] = [page.url()];
    const pageErrors: PageErrorCounter = { count: 0 };
    let popupCount = 0;

    // This harness intentionally pins the database to the W1B migration.
    // Keep later W1C/W1D reads from reaching tables that do not exist at that revision.
    await page.route(
      /\/api\/v1\/recipients\/\d+\/certification-identity(?:\?.*)?$/,
      async (route) => {
        if (route.request().method() !== 'GET') {
          await route.continue();
          return;
        }
        await route.fulfill({
          status: 404,
          json: {
            error: {
              code: 'CERTIFICATION_IDENTITY_NOT_FOUND',
              message: 'W1C is outside the isolated W1B scenario.',
            },
          },
        });
      },
    );
    await page.route(
      /\/api\/v1\/recipients\/\d+\/(?:certification-periods|grade-periods|benefit-periods|approval-amount-periods)(?:\?.*)?$/,
      async (route) => {
        if (route.request().method() !== 'GET') {
          await route.continue();
          return;
        }
        await route.fulfill({ status: 200, json: { items: [] } });
      },
    );
    await page.route(/\/api\/v1\/recipients\/\d+\/contracts(?:\?.*)?$/, async (route) => {
      if (route.request().method() !== 'GET') {
        await route.continue();
        return;
      }
      await route.fulfill({ status: 200, json: { items: [] } });
    });

    await installDomLeakObserver(page);
    page.on('pageerror', () => {
      pageErrors.count += 1;
    });
    page.on('framenavigated', (frame) => {
      if (frame === page.mainFrame()) urlSurfaces.push(frame.url());
    });
    page.on('popup', (popup) => {
      popupCount += 1;
      void popup.close();
    });
    page.on('request', (event) => {
      if (!event.url().includes('/api/')) return;
      requestCaptures.push({ body: requestBody(event), method: event.method(), url: event.url() });
    });
    page.on('response', (response) => {
      if (!response.url().includes('/api/')) return;
      responsePromises.push(
        response
          .text()
          .then((raw) => {
            responseSurfaces.push(raw);
          })
          .catch(() => {
            responseSurfaces.push('W1B_E2E_RESPONSE_BODY_UNAVAILABLE');
          }),
      );
    });

    await bootstrapIfRequired(request, pin, runKey, responseSurfaces);
    await loginInBrowser(page, pin, pageErrors);
    const created = await createRecipientViaUi(
      page,
      `${runKey}-A`,
      requestCaptures,
      responseSurfaces,
    );
    const recipientId = numberField(created, 'id', 'W1B_E2E_RECIPIENT_ID');
    const recipientName = stringField(created, 'name', 'W1B_E2E_RECIPIENT_NAME');
    await expect(page.getByTestId('recipient-detail-workspace'), 'W1B_E2E_RECIPIENT_DETAIL_WORKSPACE').toContainText(
      recipientName,
    );
    await expect(page.getByTestId('recipient-detail-home-phone'), 'W1B_E2E_RECIPIENT_DETAIL_HOME_UI').toContainText(
      '010-1000-0001',
    );
    await expect(
      page.getByTestId('recipient-detail-mobile-phone'),
      'W1B_E2E_RECIPIENT_DETAIL_MOBILE_UI',
    ).toContainText('010-1000-0002');

    await expectRecipientReadback(page, recipientId, recipientName);
    const listReadback = await browserApi(page, {
      path: `/api/v1/recipients?search=${encodeURIComponent(recipientName)}&page=1&page_size=100`,
    });
    responseSurfaces.push(listReadback.raw);
    expect(listReadback.status, 'W1B_E2E_RECIPIENT_LIST_STATUS').toBe(200);
    expect(JSON.stringify(listReadback.body), 'W1B_E2E_RECIPIENT_LIST_READBACK').toContain(recipientName);

    await createBulkRecipients(page, runKey, requestCaptures, responseSurfaces);
    const recipientBeforeStale = await expectRecipientReadback(page, recipientId, recipientName);
    const staleVersion = numberField(
      recipientBeforeStale,
      'row_version',
      'W1B_E2E_RECIPIENT_STALE_VERSION',
    );
    const externalName = `${recipientName}-EXTERNAL`;
    const externalUpdate = await browserApi(page, {
      data: { expected_row_version: staleVersion, name: externalName },
      method: 'PATCH',
      path: recipientPath(recipientId),
    });
    responseSurfaces.push(externalUpdate.raw);
    const externallyUpdated = await expectApiSuccess(
      externalUpdate,
      200,
      'W1B_E2E_RECIPIENT_EXTERNAL_UPDATE',
    );
    const externalVersion = numberField(
      externallyUpdated,
      'row_version',
      'W1B_E2E_RECIPIENT_EXTERNAL_VERSION',
    );

    const staleInput = `${recipientName}-USER-STALE`;
    await page.getByTestId('recipient-detail-name-input').fill(staleInput);
    const staleUiResponse = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === recipientPath(recipientId) &&
        response.request().method() === 'PATCH',
    );
    await page.getByRole('button', { name: '기본정보 저장', exact: true }).click();
    const staleUi = await staleUiResponse;
    const staleUiRaw = await staleUi.text();
    responseSurfaces.push(staleUiRaw);
    const staleUiBody = parseJson(staleUiRaw);
    expect(staleUi.status(), 'W1B_E2E_STALE_UI_STATUS').toBe(409);
    expect(errorCode(staleUiBody), 'W1B_E2E_STALE_UI_CODE').toBe('ROW_VERSION_CONFLICT');
    expect(
      await page.getByTestId('recipient-detail-name-input').inputValue(),
      'W1B_E2E_STALE_UI_INPUT_RETAINED',
    ).toBe(staleInput);
    const latestValue = page.getByTestId('recipient-stale-latest-value');
    const diffValue = page.getByTestId('recipient-stale-diff');
    const reapply = page.getByTestId('recipient-stale-reapply');
    await expect(latestValue, 'W1B_E2E_STALE_LATEST_VALUE_MISSING').toBeVisible();
    await expect(latestValue, 'W1B_E2E_STALE_LATEST_VALUE').toContainText(externalName);
    await expect(diffValue, 'W1B_E2E_STALE_DIFF_MISSING').toBeVisible();
    await expect(diffValue, 'W1B_E2E_STALE_DIFF').toContainText(staleInput);
    await expect(diffValue, 'W1B_E2E_STALE_DIFF_LATEST').toContainText(externalName);
    await expect(reapply, 'W1B_E2E_STALE_REAPPLY_MISSING').toBeVisible();
    const reapplyResponse = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === recipientPath(recipientId) &&
        response.request().method() === 'PATCH',
    );
    await reapply.click();
    const reapplied = await reapplyResponse;
    const reappliedRaw = await reapplied.text();
    responseSurfaces.push(reappliedRaw);
    expect(reapplied.status(), 'W1B_E2E_STALE_REAPPLY_STATUS').toBe(200);
    const reapplyRequest = findRequest(
      requestCaptures,
      (capture) =>
        new URL(capture.url).pathname === recipientPath(recipientId) &&
        capture.method === 'PATCH' &&
        asRecord(capture.body).name === staleInput,
    );
    expect(reapplyRequest, 'W1B_E2E_STALE_REAPPLY_REQUEST_MISSING').toBeDefined();
    expect(reapplyRequest?.body, 'W1B_E2E_STALE_REAPPLY_PARTIAL_PAYLOAD').toEqual({
      expected_row_version: externalVersion,
      name: staleInput,
    });
    const reappliedReadback = await browserApi(page, { path: recipientPath(recipientId) });
    responseSurfaces.push(reappliedReadback.raw);
    expect(asRecord(reappliedReadback.body).name, 'W1B_E2E_STALE_REAPPLY_READBACK').toBe(staleInput);

    const { guardianA, guardianB } = await createGuardians(page, recipientId, responseSurfaces);
    const guardianAId = numberField(guardianA, 'id', 'W1B_E2E_GUARDIAN_A_FINAL_ID');
    const guardianBId = numberField(guardianB, 'id', 'W1B_E2E_GUARDIAN_B_FINAL_ID');
    await exerciseInclusiveEndUiBoundaries(
      page,
      recipientId,
      guardianAId,
      guardianBId,
      requestCaptures,
      responseSurfaces,
    );
    await exercisePrimaryHistory(page, recipientId, guardianA, guardianB, responseSurfaces);
    await exercisePayerHistory(page, recipientId, guardianAId, responseSurfaces);

    await snapshotDomAcrossNavigations(
      page,
      domSurfacesAcrossNavigations,
      urlSurfaces,
      'W1B_E2E_DOM_BEFORE_RELOAD',
    );
    await page.reload();
    await expect(page.getByTestId('page-recipients'), 'W1B_E2E_POST_HISTORY_PAGE').toBeVisible();
    await expect(page.getByTestId('recipient-guardian-section'), 'W1B_E2E_GUARDIAN_UI_READBACK').toContainText(
      'W1B guardian B updated',
    );
    await expect(page.getByTestId('recipient-payer-snapshot-section'), 'W1B_E2E_PAYER_UI_READBACK').toContainText(
      'W1B payer recreated',
    );

    await snapshotDomAcrossNavigations(
      page,
      domSurfacesAcrossNavigations,
      urlSurfaces,
      'W1B_E2E_DOM_AFTER_RELOAD_BEFORE_GOTO',
    );
    await page.goto('/recipients');
    await expect(page.getByTestId('page-recipients'), 'W1B_E2E_CONTEXT_PAGE_READY').toBeVisible();
    await page.getByTestId('recipient-search-input').fill(runKey);
    await expect(page, 'W1B_E2E_CONTEXT_SEARCH_URL_READY').toHaveURL(
      (url) => url.searchParams.get('search') === runKey && url.searchParams.get('page') === '1',
    );
    await page.getByTestId('recipient-filter-select').selectOption('ACTIVE');
    await expect(page, 'W1B_E2E_CONTEXT_FILTER_URL_READY').toHaveURL(
      (url) =>
        url.searchParams.get('search') === runKey &&
        url.searchParams.get('filter') === 'ACTIVE' &&
        url.searchParams.get('page') === '1',
    );
    await page.getByTestId('recipient-sort-select').selectOption('name_desc');
    await expect(page, 'W1B_E2E_CONTEXT_SORT_URL_READY').toHaveURL(
      (url) =>
        url.searchParams.get('search') === runKey &&
        url.searchParams.get('filter') === 'ACTIVE' &&
        url.searchParams.get('sort') === 'name_desc' &&
        url.searchParams.get('page') === '1',
    );
    await expect(page.getByTestId('recipient-page-indicator'), 'W1B_E2E_CONTEXT_PAGE_ONE').toHaveText('1');
    const pageTwoResponsePromise = page.waitForResponse((response) => {
      const url = new URL(response.url());
      return (
        url.pathname === '/api/v1/recipients' &&
        response.request().method() === 'GET' &&
        url.searchParams.get('search') === runKey &&
        url.searchParams.get('page') === '2'
      );
    });
    await page.getByRole('button', { name: '다음', exact: true }).click();
    const pageTwoResponse = await pageTwoResponsePromise;
    await pageTwoResponse.finished();
    expect(pageTwoResponse.ok(), 'W1B_E2E_CONTEXT_PAGE_TWO_RESPONSE').toBe(true);
    await expect(page.getByTestId('recipient-page-indicator'), 'W1B_E2E_CONTEXT_PAGE_TWO').toHaveText('2');
    const pageTwoRows = page.getByTestId('recipient-name-option');
    await expect(pageTwoRows, 'W1B_E2E_CONTEXT_PAGE_TWO_ROWS').toHaveCount(3);

    const scroll = page.getByTestId('recipient-list-scroll');
    const originalStyle = await scroll.evaluate((node) => ({
      height: (node as HTMLElement).style.height,
      maxHeight: (node as HTMLElement).style.maxHeight,
    }));
    const styleHandle = await page.addStyleTag({
      content:
        '[data-testid="recipient-list-scroll"] { height: 8px !important; max-height: 8px !important; overflow-y: auto !important; }',
    });
    const scrollBefore = await scroll.evaluate((node) => {
      const element = node as HTMLElement;
      element.scrollTop = Math.max(1, element.scrollHeight - element.clientHeight);
      element.dispatchEvent(new Event('scroll', { bubbles: true }));
      return { clientHeight: element.clientHeight, scrollHeight: element.scrollHeight, scrollTop: element.scrollTop };
    });
    expect(scrollBefore.scrollHeight > scrollBefore.clientHeight, 'W1B_E2E_CONTEXT_SCROLL_REQUIRED').toBe(true);
    expect(scrollBefore.scrollTop, 'W1B_E2E_CONTEXT_SCROLL_SET').toBeGreaterThan(0);
    const contextA = await pageTwoRows.nth(0).locator('strong').innerText();
    const contextB = await pageTwoRows.nth(1).locator('strong').innerText();
    const contextBefore = new URL(page.url()).searchParams;
    const contextBeforeValues = {
      filter: contextBefore.get('filter'),
      page: contextBefore.get('page'),
      search: contextBefore.get('search'),
      sort: contextBefore.get('sort'),
    };
    await pageTwoRows.nth(0).click();
    await expect(page.getByTestId('recipient-detail-workspace'), 'W1B_E2E_CONTEXT_A_DETAIL').toContainText(contextA);
    await page.getByTestId('recipient-name-option').nth(1).click();
    await expect(page.getByTestId('recipient-detail-workspace'), 'W1B_E2E_CONTEXT_B_DETAIL').toContainText(contextB);
    await page.goBack();
    await expect(page.getByTestId('recipient-detail-workspace'), 'W1B_E2E_CONTEXT_BACK_A_DETAIL').toContainText(
      contextA,
    );
    const contextAfter = new URL(page.url()).searchParams;
    expect(contextAfter.get('filter'), 'W1B_E2E_CONTEXT_FILTER_RESTORED').toBe(contextBeforeValues.filter);
    expect(contextAfter.get('page'), 'W1B_E2E_CONTEXT_PAGE_RESTORED').toBe(contextBeforeValues.page);
    expect(contextAfter.get('search'), 'W1B_E2E_CONTEXT_SEARCH_RESTORED').toBe(contextBeforeValues.search);
    expect(contextAfter.get('sort'), 'W1B_E2E_CONTEXT_SORT_RESTORED').toBe(contextBeforeValues.sort);
    await expect(page.getByTestId('recipient-selected-name'), 'W1B_E2E_CONTEXT_SELECTED_RESTORED').toContainText(
      contextA,
    );
    await expect(
      page.getByTestId('recipient-name-option').filter({ hasText: contextA }),
      'W1B_E2E_CONTEXT_SELECTED_ROW_RESTORED',
    ).toHaveClass(/is-selected/);
    await expect
      .poll(() => scroll.evaluate((node) => (node as HTMLElement).scrollTop), {
        message: 'W1B_E2E_CONTEXT_SCROLL_RESTORED',
      })
      .toBeGreaterThan(0);
    await styleHandle.evaluate((element) => {
      (element as HTMLElement).remove();
    });
    await scroll.evaluate((node, style) => {
      const element = node as HTMLElement;
      element.style.height = style.height;
      element.style.maxHeight = style.maxHeight;
    }, originalStyle);

    await Promise.all(responsePromises);
    await snapshotDomAcrossNavigations(page, domSurfacesAcrossNavigations, urlSurfaces, 'W1B_E2E_DOM_FINAL');
    const finalDom = await page.locator('body').innerText();
    assertNoSensitiveSurface(responseSurfaces, 'W1B_E2E_RESPONSE_INTERNAL_LEAK');
    assertNoSensitiveSurface(requestCaptures, 'W1B_E2E_REQUEST_INTERNAL_LEAK');
    assertNoSensitiveSurface(domSurfacesAcrossNavigations, 'W1B_E2E_DOM_OBSERVER_LEAK');
    assertNoSensitiveSurface(finalDom, 'W1B_E2E_DOM_FINAL_LEAK');
    assertNoSensitiveSurface(urlSurfaces, 'W1B_E2E_URL_SURFACE_LEAK');
    expect(/(?:legacy_|payer_type|SELF|PRIMARY_GUARDIAN)/i.test(page.url()), 'W1B_E2E_URL_LEGACY_LEAK').toBe(
      false,
    );
    expect(popupCount, 'W1B_E2E_UNEXPECTED_POPUP').toBe(0);
    expect(pageErrors.count, 'W1B_E2E_PAGE_RUNTIME_ERROR_FINAL').toBe(0);
    const horizontalOverflow = await page.evaluate(
      () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
    );
    expect(horizontalOverflow, 'W1B_E2E_HORIZONTAL_OVERFLOW').toBe(false);
  });
});

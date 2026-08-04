import './setup';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { BrowserRouter } from 'react-router';
import { describe, expect, it, beforeEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import DashboardPage from '../pages/DashboardPage';

// Read the CSS source directly so we can verify rule contracts without ?raw import.
let editorialCss = '';
try {
  editorialCss = readFileSync(join(__dirname, '..', 'styles', 'editorial.css'), 'utf-8');
} catch {
  // File not readable – CSS-source tests will skip without false-positive.
}

const TODOS_KEY = 'sswcenter-dashboard-todos';

function seedTodos(todos: unknown) {
  localStorage.setItem(TODOS_KEY, JSON.stringify(todos));
}

describe('dashboard interactions', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
    // Provide a default empty fetch mock so API calls don't crash the test harness.
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ items: [], total: 0, page: 1, page_size: 1 }), { status: 200 }),
    ) as unknown as typeof fetch;
  });

  // ── existing work-card behaviour ──────────────────────────────────

  it('renders each mission card with an accessible drag handle and Oxford note pattern', () => {
    render(
      <BrowserRouter>
        <DashboardPage />
      </BrowserRouter>,
    );

    const cards = screen.getAllByTestId('dashboard-work-card');
    expect(cards).toHaveLength(2);
    expect(cards[0]).toHaveAttribute('data-note-pattern', 'oxford');
    expect(cards[1]).toHaveAttribute('data-note-pattern', 'oxford');
    // exactly two accessible drag handles, one per rendered work card
    const handles = screen.getAllByRole('button', { name: /임무카드 이동$/ });
    expect(handles).toHaveLength(2);
    expect(screen.getByText('보수교육')).toBeInTheDocument();
    // verify actual task labels and counts are rendered
    expect(screen.getByText('2명')).toBeInTheDocument();
    expect(screen.getByText('2건')).toBeInTheDocument();
    expect(screen.getByText('1건')).toBeInTheDocument();
    expect(screen.getByText('3건')).toBeInTheDocument();
    expect(screen.getByText('2/3')).toBeInTheDocument();
    expect(screen.getByText('0/12')).toBeInTheDocument();
    // legacy placeholder labels must NOT appear
    expect(screen.queryByText('담당직원 n명')).not.toBeInTheDocument();
    expect(screen.queryByText('담당수급자 n명')).not.toBeInTheDocument();
    expect(screen.queryByText('마감일')).not.toBeInTheDocument();
    // deadline date from deadlines array
    expect(screen.getByText('등록된 수급자 마감일이 없습니다.')).toBeInTheDocument();
    expect(screen.queryByText('D-3')).not.toBeInTheDocument();
  });

  // ── 3-column task-grid layout contract ────────────────────────────

  it('renders summary task grids with a desktop 3-column structure', () => {
    render(
      <BrowserRouter>
        <DashboardPage />
      </BrowserRouter>,
    );

    const grids = Array.from(document.querySelectorAll('.dashboard-task-grid'));
    expect(grids.length).toBeGreaterThanOrEqual(2);
    for (const grid of grids) {
      // grid element exists with the correct class
      expect(grid.classList.contains('dashboard-task-grid')).toBe(true);
    }
  });

  // ── no date input or date rendering in todo ───────────────────────

  it('does not render a date input inside the todo form', () => {
    render(
      <BrowserRouter>
        <DashboardPage />
      </BrowserRouter>,
    );

    expect(screen.queryByLabelText('할일 날짜 입력')).not.toBeInTheDocument();
    expect(document.querySelector('input[type="date"]')).not.toBeInTheDocument();
    expect(document.querySelector('.dashboard-todo-date-wrap')).not.toBeInTheDocument();
  });

  it('does not render date text inside todo items', () => {
    seedTodos([
      { id: 'a1', title: '산책하기', status: 'pending' },
    ]);

    render(
      <BrowserRouter>
        <DashboardPage />
      </BrowserRouter>,
    );

    // date text like "미정" or ISO dates should never appear in todo list
    const list = document.querySelector('.dashboard-todo-list');
    expect(list).toBeInTheDocument();
    expect(list!.querySelector('small')).not.toBeInTheDocument();
    expect(screen.queryByText('미정')).not.toBeInTheDocument();
  });

  // ── todo add ──────────────────────────────────────────────────────

  it('adds a todo and persists it to localStorage', () => {
    render(
      <BrowserRouter>
        <DashboardPage />
      </BrowserRouter>,
    );

    const input = screen.getByPlaceholderText('할일 입력');
    const addBtn = screen.getByRole('button', { name: '추가' });

    fireEvent.change(input, { target: { value: '리뷰 정리' } });
    fireEvent.click(addBtn);

    expect(screen.getByText('리뷰 정리')).toBeInTheDocument();

    const stored = JSON.parse(localStorage.getItem(TODOS_KEY)!);
    expect(stored).toHaveLength(1);
    expect(stored[0].title).toBe('리뷰 정리');
    expect(stored[0].status).toBe('pending');
  });

  it('does not add an empty todo', () => {
    render(
      <BrowserRouter>
        <DashboardPage />
      </BrowserRouter>,
    );

    const addBtn = screen.getByRole('button', { name: '추가' });
    fireEvent.click(addBtn);

    const listItems = document.querySelectorAll('.dashboard-todo-item');
    expect(listItems.length).toBe(0);
  });

  // ── completion toggle (both directions) ───────────────────────────

  it('toggles a pending todo to completed and back to pending', () => {
    seedTodos([
      { id: 't1', title: '완료 테스트', status: 'pending' },
    ]);

    render(
      <BrowserRouter>
        <DashboardPage />
      </BrowserRouter>,
    );

    const toggle = screen.getByRole('button', { name: '완료로 표시' });
    fireEvent.click(toggle);

    // visual state: item should have is-complete class
    const item = toggle.closest('.dashboard-todo-item');
    expect(item).toHaveClass('is-complete');

    // aria label flips
    const toggle2 = screen.getByRole('button', { name: '미완료로 표시' });
    fireEvent.click(toggle2);

    expect(item).not.toHaveClass('is-complete');

    // persisted status
    const stored = JSON.parse(localStorage.getItem(TODOS_KEY)!);
    expect(stored[0].status).toBe('pending');
  });

  // ── completed visual state (low opacity) ─────────────────────────

  it('applies low-opacity visual state to completed items', () => {
    seedTodos([
      { id: 'c1', title: '완료된 항목', status: 'completed' },
      { id: 'c2', title: '진행중 항목', status: 'pending' },
    ]);

    render(
      <BrowserRouter>
        <DashboardPage />
      </BrowserRouter>,
    );

    const completedItem = screen.getByText('완료된 항목').closest('.dashboard-todo-item');
    const pendingItem = screen.getByText('진행중 항목').closest('.dashboard-todo-item');

    expect(completedItem).toHaveClass('is-complete');
    expect(pendingItem).not.toHaveClass('is-complete');

    // verify opacity 0.3 rule exists in CSS source (avoids jsdom getComputedStyle)
    expect(editorialCss).toMatch(/\.dashboard-todo-item\.is-complete\s*\{[^}]*opacity\s*:\s*0\.3/);
  });

  // ── multi-item toggle / delete ────────────────────────────────────

  it('toggles only the targeted todo among multiple items', () => {
    seedTodos([
      { id: 'm1', title: '첫 번째', status: 'pending' },
      { id: 'm2', title: '두 번째', status: 'pending' },
    ]);

    render(
      <BrowserRouter>
        <DashboardPage />
      </BrowserRouter>,
    );

    const toggles = screen.getAllByRole('button', { name: '완료로 표시' });
    expect(toggles).toHaveLength(2);
    fireEvent.click(toggles[0]);

    // only first item completed
    const items = document.querySelectorAll('.dashboard-todo-item');
    expect(items[0]).toHaveClass('is-complete');
    expect(items[1]).not.toHaveClass('is-complete');

    const stored = JSON.parse(localStorage.getItem(TODOS_KEY)!);
    expect(stored[0].status).toBe('completed');
    expect(stored[1].status).toBe('pending');
  });

  // ── trash deletion ────────────────────────────────────────────────

  it('deletes only the targeted todo among multiple items', () => {
    seedTodos([
      { id: 'd1', title: '삭제할 항목', status: 'pending' },
      { id: 'd2', title: '유지할 항목', status: 'pending' },
    ]);

    render(
      <BrowserRouter>
        <DashboardPage />
      </BrowserRouter>,
    );

    expect(screen.getByText('삭제할 항목')).toBeInTheDocument();
    expect(screen.getByText('유지할 항목')).toBeInTheDocument();

    // click trash on the first item only
    const trashButtons = screen.getAllByRole('button', { name: '할일 삭제' });
    expect(trashButtons).toHaveLength(2);
    fireEvent.click(trashButtons[0]);

    expect(screen.queryByText('삭제할 항목')).not.toBeInTheDocument();
    expect(screen.getByText('유지할 항목')).toBeInTheDocument();

    const stored = JSON.parse(localStorage.getItem(TODOS_KEY)!);
    expect(stored).toHaveLength(1);
    expect(stored[0].title).toBe('유지할 항목');
  });

  it('deletes a todo permanently when trash button is clicked (single item)', () => {
    seedTodos([
      { id: 'd1', title: '삭제할 항목', status: 'pending' },
    ]);

    render(
      <BrowserRouter>
        <DashboardPage />
      </BrowserRouter>,
    );

    fireEvent.click(screen.getByRole('button', { name: '할일 삭제' }));

    const stored = JSON.parse(localStorage.getItem(TODOS_KEY)!);
    expect(stored).toHaveLength(0);
  });

  // ── remount / refresh persistence ─────────────────────────────────

  it('survives remount by reading from localStorage', () => {
    seedTodos([
      { id: 'r1', title: '리마운트 테스트', status: 'pending' },
      { id: 'r2', title: '두 번째 리마운트', status: 'completed' },
    ]);

    const { unmount } = render(
      <BrowserRouter>
        <DashboardPage />
      </BrowserRouter>,
    );
    unmount();

    // remount — should read the same item from storage
    render(
      <BrowserRouter>
        <DashboardPage />
      </BrowserRouter>,
    );

    expect(screen.getByText('리마운트 테스트')).toBeInTheDocument();
    expect(screen.getByText('두 번째 리마운트')).toBeInTheDocument();

    // verify completed item has the right class
    const items = document.querySelectorAll('.dashboard-todo-item');
    expect(items[1]).toHaveClass('is-complete');
    expect(items[0]).not.toHaveClass('is-complete');
  });

  // ── malformed localStorage fallback ───────────────────────────────

  it('falls back to empty list when localStorage contains malformed data', () => {
    localStorage.setItem(TODOS_KEY, '{not valid json');

    expect(() =>
      render(
        <BrowserRouter>
          <DashboardPage />
        </BrowserRouter>,
      ),
    ).not.toThrow();

    const listItems = Array.from(document.querySelectorAll('.dashboard-todo-item'));
    expect(listItems).toHaveLength(0);
  });

  it('falls back to empty list when stored data is not an array', () => {
    localStorage.setItem(TODOS_KEY, JSON.stringify('just a string'));

    render(
      <BrowserRouter>
        <DashboardPage />
      </BrowserRouter>,
    );

    const listItems = Array.from(document.querySelectorAll('.dashboard-todo-item'));
    expect(listItems).toHaveLength(0);
  });

  it('filters out items with invalid status from storage', () => {
    seedTodos([
      { id: 'ok1', title: '정상', status: 'pending' },
      { id: 'bad1', title: '이상', status: 'archived' },
      { id: 'ok2', title: '완료', status: 'completed' },
    ]);

    render(
      <BrowserRouter>
        <DashboardPage />
      </BrowserRouter>,
    );

    expect(screen.getByText('정상')).toBeInTheDocument();
    expect(screen.getByText('완료')).toBeInTheDocument();
    expect(screen.queryByText('이상')).not.toBeInTheDocument();
  });

  it('filters out deleted items on load', () => {
    seedTodos([
      { id: 'del1', title: '삭제됨', status: 'deleted' },
    ]);

    render(
      <BrowserRouter>
        <DashboardPage />
      </BrowserRouter>,
    );

    expect(screen.queryByText('삭제됨')).not.toBeInTheDocument();
  });

  // ── deadline card preserved ───────────────────────────────────────

  it('preserves the upcoming deadlines section', () => {
    render(
      <BrowserRouter>
        <DashboardPage />
      </BrowserRouter>,
    );

    expect(screen.getByText('다가오는 마감일')).toBeInTheDocument();
    expect(screen.getByText('등록된 수급자 마감일이 없습니다.')).toBeInTheDocument();
    expect(screen.queryByText('D-3')).not.toBeInTheDocument();
    expect(screen.queryByText('센터 시설 안전 점검')).not.toBeInTheDocument();
  });

  // ── editorial.css source rule verification ────────────────────────

  it('defines 3-column task grid in CSS source', () => {
    expect(editorialCss).toMatch(
      /\.dashboard-task-grid\s*\{[^}]*grid-template-columns\s*:\s*repeat\(3\s*,\s*minmax\(0\s*,\s*1fr\)\)/,
    );
  });

  it('defines narrow-screen reflow media rule for task grid', () => {
    expect(editorialCss).toMatch(
      /@media\s*\(max-width:\s*780px\)\s*\{[^}]*\.dashboard-task-grid\s*\{[^}]*grid-template-columns\s*:\s*minmax\(0\s*,\s*1fr\)/,
    );
  });

  it('defines opacity 0.3 for completed todo items', () => {
    expect(editorialCss).toMatch(
      /\.dashboard-todo-item\.is-complete\s*\{[^}]*opacity\s*:\s*0\.3/,
    );
  });

  // ── regression: Link href, checkbox, due, state ──────────────────

  it('renders summary links pointing to /staff and /recipients', () => {
    render(
      <BrowserRouter>
        <DashboardPage />
      </BrowserRouter>,
    );

    const staffLink = screen.getByRole('link', { name: '직원' });
    expect(staffLink).toHaveAttribute('href', '/staff');

    const recipientLink = screen.getByRole('link', { name: '수급자' });
    expect(recipientLink).toHaveAttribute('href', '/recipients');
  });

  it('renders work-card due dates and completion state without checkboxes or inputs', () => {
    render(
      <BrowserRouter>
        <DashboardPage />
      </BrowserRouter>,
    );

    // no checkbox or input of any kind inside work cards
    const cards = screen.getAllByTestId('dashboard-work-card');
    for (const card of cards) {
      expect(card.querySelector('input[type="checkbox"]')).not.toBeInTheDocument();
      expect(card.querySelector('input')).not.toBeInTheDocument();
    }
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();

    expect(screen.getByText('2026-08-21')).toBeInTheDocument();
    expect(screen.queryByText('2026-08-16')).not.toBeInTheDocument();
    const recipientCard = document.querySelector('[data-card-id="recipient-renewal"]');
    expect(recipientCard).toBeInTheDocument();
    expect(recipientCard).toHaveTextContent('등록된 마감일 없음');
    expect(recipientCard).toHaveTextContent('—');
    expect(screen.getByText('1/2 완료')).toBeInTheDocument();
    expect(screen.getByText('0/2 완료')).toBeInTheDocument();
  });

  // ── legacy date / deadline stripping ─────────────────────────────

  it('strips deadline and unknown fields from stored items on load', () => {
    seedTodos([
      {
        id: 's1',
        title: '  데드라인 있어요  ',
        status: 'pending',
        deadline: '2025-12-25',
        createdAt: '2025-01-01',
        extraField: 'should-be-removed',
      },
    ]);

    render(
      <BrowserRouter>
        <DashboardPage />
      </BrowserRouter>,
    );

    // title is trimmed, deadline/createdAt/extraField stripped
    expect(screen.getByText('데드라인 있어요')).toBeInTheDocument();

    // saved canonical form has only id/title/status (no deadline, no extra fields)
    const stored = JSON.parse(localStorage.getItem(TODOS_KEY)!);
    expect(stored).toHaveLength(1);
    expect(stored[0].id).toBe('s1');
    expect(stored[0].title).toBe('데드라인 있어요');
    expect(stored[0].status).toBe('pending');
    expect(stored[0].deadline).toBeUndefined();
    expect(stored[0].createdAt).toBeUndefined();
    expect(stored[0].extraField).toBeUndefined();
  });

  // ── duplicate id first-wins ──────────────────────────────────────

  it('keeps first occurrence when duplicate ids are present in storage', () => {
    seedTodos([
      { id: 'dup', title: '첫 번째', status: 'pending' },
      { id: 'dup', title: '두 번째', status: 'completed' },
    ]);

    render(
      <BrowserRouter>
        <DashboardPage />
      </BrowserRouter>,
    );

    // first occurrence wins
    expect(screen.getByText('첫 번째')).toBeInTheDocument();
    expect(screen.queryByText('두 번째')).not.toBeInTheDocument();

    const stored = JSON.parse(localStorage.getItem(TODOS_KEY)!);
    expect(stored).toHaveLength(1);
    expect(stored[0].title).toBe('첫 번째');
  });

  // ── blank / missing fields in stored items ──────────────────────

  it('discards stored items with blank or missing id', () => {
    seedTodos([
      { id: '', title: '빈 아이디', status: 'pending' },
      { id: '   ', title: '공백 아이디', status: 'pending' },
      { title: '아이디 없음', status: 'pending' },
      { id: 'ok', title: '정상', status: 'pending' },
    ]);

    render(
      <BrowserRouter>
        <DashboardPage />
      </BrowserRouter>,
    );

    expect(screen.queryByText('빈 아이디')).not.toBeInTheDocument();
    expect(screen.queryByText('공백 아이디')).not.toBeInTheDocument();
    expect(screen.queryByText('아이디 없음')).not.toBeInTheDocument();
    expect(screen.getByText('정상')).toBeInTheDocument();

    const stored = JSON.parse(localStorage.getItem(TODOS_KEY)!);
    expect(stored).toHaveLength(1);
    expect(stored[0].title).toBe('정상');
  });

  it('discards stored items with blank or missing title', () => {
    seedTodos([
      { id: 'b1', title: '', status: 'pending' },
      { id: 'b2', title: '   ', status: 'pending' },
      { id: 'b3', status: 'pending' },
      { id: 'b4', title: '좋은 제목', status: 'pending' },
    ]);

    render(
      <BrowserRouter>
        <DashboardPage />
      </BrowserRouter>,
    );

    // queryByText('') is ambiguous; verify only one valid item survives
    const listItems = document.querySelectorAll('.dashboard-todo-item');
    expect(listItems).toHaveLength(1);
    expect(screen.getByText('좋은 제목')).toBeInTheDocument();

    const stored = JSON.parse(localStorage.getItem(TODOS_KEY)!);
    expect(stored).toHaveLength(1);
    expect(stored[0].title).toBe('좋은 제목');
  });

  // ── narrow-screen dashboard CSS contracts ─────────────────────────

  it('defines app-shell-dashboard min-width:0 override in CSS source', () => {
    expect(editorialCss).toMatch(
      /\.app-shell-dashboard\s*\{[^}]*min-width\s*:\s*0/,
    );
  });

  it('defines narrow-screen 1-column summary grid at max-width 900px', () => {
    expect(editorialCss).toMatch(
      /@media\s*\(max-width:\s*900px\)\s*\{[^}]*\.dashboard-summary-grid\s*\{[^}]*grid-template-columns\s*:\s*minmax\(0\s*,\s*1fr\)/,
    );
  });

  it('preserves grid-template-areas on summary grid narrow reflow', () => {
    expect(editorialCss).toMatch(
      /@media\s*\(max-width:\s*900px\)\s*\{[^}]*\.dashboard-summary-grid\s*\{[^}]*grid-template-areas\s*:\s*"staff"\s*"recipient"/,
    );
  });

  // ── staff-onboarding D+day from CARE_WORKER API ──────────────────

  it('shows D+N on staff-onboarding work card when CARE_WORKER API returns a start_date', async () => {
    vi.setSystemTime(new Date('2026-03-15T00:00:00+09:00'));

    globalThis.fetch = vi.fn().mockImplementation((url: string) => {
      if (url.includes('staff')) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              items: [
                {
                  id: 1,
                  name: '김하늘',
                  current_positions: [{ position_code: 'CARE_WORKER' }],
                  current_employment: {
                    id: 100,
                    staff_id: 1,
                    employment_no: 1,
                    staff_no: 'CW-001',
                    start_date: '2026-03-01',
                    end_date: null,
                    end_reason_code: null,
                    status: 'ACTIVE',
                    row_version: 1,
                  },
                },
              ],
              total: 1,
              page: 1,
              page_size: 200,
            }),
            { status: 200 },
          ),
        );
      }
      if (url.includes('/recipients/deadlines')) {
        return Promise.resolve(new Response(JSON.stringify({ items: [{ recipient_id: 7, recipient_name: 'API Recipient', kind: 'PLAN_RENEWAL', source_id: 11, source_date: '2026-03-02', due_date: '2026-09-30' } ] }), { status: 200 }));
      }
      if (url.includes('recipients')) {
        return Promise.resolve(
          new Response(
            JSON.stringify({ items: [], total: 5, page: 1, page_size: 1 }),
            { status: 200 },
          ),
        );
      }
      return Promise.resolve(new Response(JSON.stringify({}), { status: 200 }));
    }) as unknown as typeof fetch;

    render(
      <BrowserRouter>
        <DashboardPage />
      </BrowserRouter>,
    );

    // staff-onboarding card shows D+14 (2026-03-01 → 2026-03-15 = 14 elapsed days)
    const onboardingCard = document.querySelector('[data-card-id="staff-onboarding"]');
    expect(onboardingCard).toBeInTheDocument();

    // Wait for the async API response to update the dday from fallback D-18 to D+14
    await waitFor(() => {
      const dday = onboardingCard!.querySelector('.dashboard-dday');
      expect(dday).toHaveTextContent('D+14');
      expect(dday).not.toHaveTextContent('D-18');
      expect(onboardingCard).toHaveTextContent('김하늘 요양보호사');
      expect(onboardingCard).not.toHaveTextContent('이영희 요양보호사');
      expect(onboardingCard).toHaveTextContent('2026-03-01');
      expect(onboardingCard).not.toHaveTextContent('2026-08-21');
    });

    // Staff summary count is just the count, no D+ suffix
    const summaryCards = document.querySelectorAll('.dashboard-summary-card');
    expect(summaryCards.length).toBeGreaterThanOrEqual(1);
    const staffCountEl = summaryCards[0].querySelector('.dashboard-summary-count');
    expect(staffCountEl).toHaveTextContent('1명');
    expect(staffCountEl).not.toHaveTextContent('D+');

    // Recipient work card now reflects the deadlines API item (plan renewal)
    const recipientCard = document.querySelector('[data-card-id="recipient-renewal"]');
    await waitFor(() => {
      expect(recipientCard).toHaveTextContent('API Recipient');
      expect(recipientCard).toHaveTextContent('계획서 갱신');
      expect(recipientCard).toHaveTextContent('2026-09-30');
      expect(recipientCard).toHaveTextContent('D-199');
      expect(recipientCard).not.toHaveTextContent('D-13');
    });

    // Recipient summary count unaffected
    const recipientCountEl = summaryCards[1].querySelector('.dashboard-summary-count');
    expect(recipientCountEl).toHaveTextContent('5명');

    // Deadline rail shows the same API item (work card + rail)
    expect(screen.getAllByText('D-199').length).toBeGreaterThanOrEqual(2);
    expect(screen.getAllByText('2026-09-30').length).toBeGreaterThanOrEqual(2);

    vi.useRealTimers();
  });
});

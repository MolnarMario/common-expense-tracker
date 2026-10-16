import { createStore, THEMES } from './state.js';
import { computeSettlement, balanceBar } from './settlement.js';
import {
  parseAmount,
  sanitizeAmountInput,
  formatMoney,
  formatPlain,
  formatSignedPlain,
  MINOR_UNIT,
} from './money.js';
import { createStorage, createDeviceMemory, LOCAL_KEY } from './storage.js';
import { createSharing, MODE } from './sharing.js';
import { STATUS } from './sync.js';
import { isRoomId, knownRooms, readRoomId, syncEndpoint } from './room-link.js';
import { currentMonthId, shiftMonth, monthLabel, defaultDateFor, parseMonthId } from './months.js';
import {
  exportableMonths,
  buildExport,
  parseImportFile,
  previewImport,
} from './transfer.js';

const prefersDark =
  typeof window.matchMedia === 'function' &&
  window.matchMedia('(prefers-color-scheme: dark)').matches;

/**
 * Set once the sharing layer exists. Every local change to shared data
 * comes through onOps below; with no room open it goes nowhere, which is
 * what lets the whole app work exactly as it did before any of this.
 */
let sharing = null;

const store = createStore(createStorage(LOCAL_KEY), {
  defaultTheme: prefersDark ? 'dark' : 'light',
  onOps: (ops) => {
    if (sharing) sharing.push(ops);
  },
});

const $ = (id) => document.getElementById(id);

const el = {
  prevMonth: $('prev-month'),
  nextMonth: $('next-month'),
  thisMonth: $('this-month'),
  monthPicker: $('month-picker'),
  monthLabel: $('month-label'),
  themeToggle: $('theme-toggle'),
  themeLabel: $('theme-label'),
  openPeople: $('open-people'),
  peopleCount: $('people-count'),

  peopleDialog: $('people-dialog'),
  addPersonForm: $('add-person-form'),
  personName: $('person-name'),
  personError: $('person-error'),
  peopleList: $('people-list'),
  peopleEmpty: $('people-empty'),

  addExpenseForm: $('add-expense-form'),
  expenseAmount: $('expense-amount'),
  expensePayer: $('expense-payer'),
  expenseDate: $('expense-date'),
  expenseDescription: $('expense-description'),
  expenseError: $('expense-error'),
  expenseFormBlocked: $('expense-form-blocked'),
  blockedAddPeople: $('blocked-add-people'),
  addExpenseBtn: $('add-expense-btn'),

  expenseRows: $('expense-rows'),
  expensesEmpty: $('expenses-empty'),
  expenseTable: $('expense-table'),
  expenseCount: $('expense-count'),

  settlement: $('settlement'),
  summaryTotal: $('summary-total'),
  totalSpent: $('total-spent'),
  fairShareLine: $('fair-share-line'),
  balanceBarFigure: $('balance-bar'),
  barFills: $('bar-fills'),
  barRules: $('bar-rules'),
  barFlags: $('bar-flags'),
  barCaption: $('bar-caption'),
  balanceRows: $('balance-rows'),
  balanceTable: $('balance-table'),
  balanceScroll: $('balance-scroll'),
  transferList: $('transfer-list'),
  transfersHeading: document.querySelector('.transfers-heading'),
  settledNote: $('settled-note'),
  settlementEmpty: $('settlement-empty'),

  expenseDialog: $('expense-dialog'),
  editForm: $('edit-expense-form'),
  editAmount: $('edit-amount'),
  editPayer: $('edit-payer'),
  editDate: $('edit-date'),
  editDescription: $('edit-description'),
  editError: $('edit-error'),

  confirmDialog: $('confirm-dialog'),
  confirmTitle: $('confirm-title'),
  confirmMessage: $('confirm-message'),
  confirmAccept: $('confirm-accept'),

  removeDialog: $('remove-person-dialog'),
  removeForm: $('remove-person-form'),
  removeName: $('remove-person-name'),
  removeMessage: $('remove-person-message'),
  reassignTarget: $('reassign-target'),
  removeError: $('remove-person-error'),

  openData: $('open-data'),
  footerData: $('footer-data'),
  dataDialog: $('data-dialog'),
  exportMonths: $('export-months'),
  exportEmpty: $('export-empty'),
  exportAll: $('export-all'),
  exportNone: $('export-none'),
  exportBtn: $('export-btn'),
  exportError: $('export-error'),
  importFile: $('import-file'),
  importFileLabel: $('import-file-label'),
  importError: $('import-error'),

  importDialog: $('import-dialog'),
  importSummary: $('import-summary'),
  importPreview: $('import-preview'),
  importPeople: $('import-people'),
  importUntouched: $('import-untouched'),
  importWarning: $('import-warning'),
  importAccept: $('import-accept'),

  openShare: $('open-share'),
  syncDot: $('sync-dot'),
  footerLocal: $('footer-local'),
  footerShared: $('footer-shared'),

  shareDialog: $('share-dialog'),
  shareIntro: $('share-intro'),
  shareUnavailable: $('share-unavailable'),
  shareCreate: $('share-create'),
  shareJoin: $('share-join'),
  shareActive: $('share-active'),
  shareStatus: $('share-status'),

  createRoomForm: $('create-room-form'),
  inviteCode: $('invite-code'),
  newPassword: $('new-password'),
  newPasswordAgain: $('new-password-again'),
  createRoomBtn: $('create-room-btn'),
  createError: $('create-error'),

  joinRoomForm: $('join-room-form'),
  joinLink: $('join-link'),
  joinError: $('join-error'),
  knownRoomsLabel: $('known-rooms-label'),
  knownRoomsList: $('known-rooms'),

  shareLink: $('share-link'),
  copyLink: $('copy-link'),
  moveLocal: $('move-local'),
  moveLocalNote: $('move-local-note'),
  usageBlock: $('usage-block'),
  usageFill: $('usage-fill'),
  usageLabel: $('usage-label'),
  showRecovery: $('show-recovery'),
  changePassword: $('change-password'),
  leaveRoom: $('leave-room'),

  unlockDialog: $('unlock-dialog'),
  unlockForm: $('unlock-form'),
  unlockIntro: $('unlock-intro'),
  passwordField: $('password-field'),
  unlockPassword: $('unlock-password'),
  recoveryField: $('recovery-field'),
  unlockRecovery: $('unlock-recovery'),
  unlockError: $('unlock-error'),
  unlockBtn: $('unlock-btn'),
  useRecovery: $('use-recovery'),

  recoveryDialog: $('recovery-dialog'),
  recoveryTitle: $('recovery-title'),
  recoveryIntro: $('recovery-intro'),
  recoveryKey: $('recovery-key'),
  copyRecovery: $('copy-recovery'),
  recoveryWarning: $('recovery-warning'),

  passwordDialog: $('password-dialog'),
  passwordForm: $('password-form'),
  changeNew: $('change-new'),
  changeAgain: $('change-again'),
  changeError: $('change-error'),

  toast: $('toast'),
};

let editingExpenseId = null;
let removingPersonId = null;

/** Month ids ticked for export. Survives re-renders of the list. */
const exportSelection = new Set();
let pendingImport = null;

// ---------------------------------------------------------------- rendering

function render() {
  const month = store.getCurrentMonth();
  const people = store.getPeople();
  const settlement = computeSettlement({ people, expenses: month.expenses });
  const focusKey = document.activeElement && document.activeElement.dataset
    ? document.activeElement.dataset.focusKey
    : null;

  renderHeader(month, people);
  renderPeopleDialog(people);
  renderExpenseForm(people, month);
  renderExpenses(month, people);
  renderSettlement(month, people, settlement);
  if (el.dataDialog.open) renderExportMonths();

  if (focusKey) {
    const again = document.querySelector('[data-focus-key="' + cssEscape(focusKey) + '"]');
    if (again) again.focus();
  }
}

function cssEscape(value) {
  return window.CSS && CSS.escape ? CSS.escape(value) : value.replace(/"/g, '\\"');
}

function headcount(n) {
  return n === 1 ? '1 person' : n + ' people';
}

function renderHeader(month, people) {
  el.monthPicker.value = month.id;
  el.monthLabel.textContent = monthLabel(month.id);
  el.thisMonth.hidden = month.id === currentMonthId();
  el.peopleCount.textContent = String(people.length);
  el.openPeople.setAttribute('aria-label', 'People: ' + headcount(people.length));
  renderTheme(store.getState().theme);
}

const THEME_WORD = { light: 'light', dark: 'dark' };

function renderTheme(theme) {
  document.documentElement.dataset.theme = theme;
  const next = otherTheme(theme);
  const label = 'Switch to ' + THEME_WORD[next] + ' mode';
  el.themeToggle.title = label;
  el.themeToggle.setAttribute('aria-label', label);
  el.themeLabel.textContent = label;
}

function otherTheme(theme) {
  return THEMES[(THEMES.indexOf(theme) + 1) % THEMES.length];
}

function renderPeopleDialog(people) {
  el.peopleEmpty.hidden = people.length > 0;
  el.peopleList.replaceChildren();

  for (const person of people) {
    const li = document.createElement('li');
    li.className = 'person-row';

    const nameInput = document.createElement('input');
    nameInput.type = 'text';
    nameInput.className = 'person-name';
    nameInput.value = person.name;
    nameInput.maxLength = 40;
    nameInput.dataset.personId = person.id;
    nameInput.dataset.focusKey = 'person-' + person.id;
    nameInput.setAttribute('aria-label', 'Name of ' + person.name);

    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'link-btn';
    remove.textContent = 'Remove';
    remove.setAttribute('aria-label', 'Remove ' + person.name);
    remove.addEventListener('click', () => startRemovePerson(person.id));

    li.append(nameInput, remove);
    el.peopleList.append(li);
  }
}

function renderExpenseForm(people, month) {
  const hasPeople = people.length > 0;
  fillPersonSelect(el.expensePayer, people, el.expensePayer.value);
  el.expenseFormBlocked.hidden = hasPeople;
  el.addExpenseBtn.disabled = !hasPeople;
  el.expenseAmount.disabled = !hasPeople;
  el.expensePayer.disabled = !hasPeople;
  el.expenseDescription.disabled = !hasPeople;
  el.expenseDate.disabled = !hasPeople;
  if (!el.expenseDate.value) el.expenseDate.value = defaultDateFor(month.id);
}

function fillPersonSelect(select, people, preferredValue) {
  const wanted = people.some((p) => p.id === preferredValue)
    ? preferredValue
    : people.length > 0
      ? people[0].id
      : '';
  select.replaceChildren();
  for (const person of people) {
    const option = document.createElement('option');
    option.value = person.id;
    option.textContent = person.name;
    select.append(option);
  }
  select.value = wanted;
}

function sortedExpenses(month) {
  // Newest first. Undated entries sink to the bottom; ties keep the most
  // recently added on top.
  return month.expenses
    .map((expense, index) => ({ expense, index }))
    .sort((a, b) => {
      const dateA = a.expense.date || '';
      const dateB = b.expense.date || '';
      if (dateA !== dateB) {
        if (!dateA) return 1;
        if (!dateB) return -1;
        return dateB < dateA ? -1 : 1;
      }
      return b.index - a.index;
    })
    .map((entry) => entry.expense);
}

function renderExpenses(month, people) {
  const nameById = new Map(people.map((p) => [p.id, p.name]));
  const list = sortedExpenses(month);

  el.expenseCount.textContent = list.length === 1 ? '1 expense' : list.length + ' expenses';
  el.expensesEmpty.hidden = list.length > 0;
  el.expenseTable.hidden = list.length === 0;
  el.expenseRows.replaceChildren();

  for (const expense of list) {
    const tr = document.createElement('tr');

    const date = document.createElement('td');
    date.className = 'expense-date';
    date.textContent = shortDate(expense.date);

    const description = document.createElement('td');
    description.className = 'expense-description';
    if (expense.description) {
      description.textContent = expense.description;
    } else {
      const none = document.createElement('span');
      none.className = 'no-description';
      none.textContent = 'No description';
      description.append(none);
    }

    const payer = document.createElement('td');
    payer.textContent = nameById.get(expense.payerId) || 'Unknown';

    const amount = document.createElement('td');
    amount.className = 'numeric amount';
    amount.textContent = formatMoney(expense.amount);

    const actions = document.createElement('td');
    const wrap = document.createElement('div');
    wrap.className = 'row-actions';

    const edit = document.createElement('button');
    edit.type = 'button';
    edit.className = 'link-btn';
    edit.textContent = 'Edit';
    edit.setAttribute('aria-label', 'Edit expense of ' + formatMoney(expense.amount));
    edit.addEventListener('click', () => openEditDialog(expense.id));

    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'link-btn';
    remove.textContent = 'Delete';
    remove.setAttribute(
      'aria-label',
      'Delete expense of ' + formatMoney(expense.amount)
    );
    remove.addEventListener('click', () => confirmDeleteExpense(expense));

    wrap.append(edit, remove);
    actions.append(wrap);
    tr.append(date, description, payer, amount, actions);
    el.expenseRows.append(tr);
  }
}

function shortDate(iso) {
  if (!iso) return 'no date';
  const parts = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!parts) return iso;
  return parts[3] + '.' + parts[2];
}

// Eight hues, handed out in roster order. Person nine and beyond share the
// neutral fallback rather than getting a made-up colour; the balance table
// still names every one of them.
const SERIES_COUNT = 8;

// How close to an end the fair-share flag can sit before it gets pinned
// there instead of centred on its tick.
const FLAG_EDGE = 0.12;

function pct(fraction) {
  return (fraction * 100).toFixed(4) + '%';
}

/**
 * The bottom line as one line: the month's spending laid out left to right,
 * each person holding a slice as wide as what they paid, overpayers first.
 * The bold tick is the fair share. The colour boundary always lands right
 * of it, and the washed-out stretch between the two is the money that moves.
 */
function renderBalanceBar(settlement) {
  const bar = balanceBar(settlement);

  el.barFills.replaceChildren();
  el.barRules.replaceChildren();
  el.barFlags.replaceChildren();
  el.balanceBarFigure.hidden = bar.segments.length === 0;
  if (bar.segments.length === 0) return;

  const money = formatMoney;

  for (const seg of bar.segments) {
    if (seg.width <= 0) continue;

    const fill = document.createElement('div');
    fill.className = 'bar-seg';
    if (seg.colorIndex < SERIES_COUNT) fill.dataset.series = String(seg.colorIndex);
    fill.style.left = pct(seg.start);
    fill.style.width = pct(seg.width);
    fill.title =
      seg.name +
      ' paid ' +
      money(seg.paid) +
      ' of ' +
      money(seg.share) +
      ' owed' +
      (seg.net === 0 ? '' : ', ' + money(Math.abs(seg.net)) + (seg.net > 0 ? ' over' : ' under'));
    el.barFills.append(fill);

    // The name goes in the part of the slice the washed stretch leaves
    // alone. A slice swallowed by it whole gets no name: the wash is drawn
    // over the slices, so the chip would be buried under it.
    const slot = clearSlot(seg, bar.crossing);
    if (slot) {
      addChip(fill, slot, seg, [
        seg.name + '  ' + money(seg.paid),
        seg.name + '  ' + formatPlain(seg.paid),
        seg.name,
      ]);
    }

    const over = excessPart(seg, bar.crossing);
    if (over) {
      const faded = document.createElement('div');
      faded.className = 'bar-excess';
      faded.style.left = pct((over.start - seg.start) / seg.width);
      faded.style.width = pct(over.width / seg.width);
      fill.append(faded);
    }
  }

  if (bar.crossing) {
    const band = document.createElement('div');
    band.className = 'bar-band';
    band.style.left = pct(bar.crossing.at);
    band.style.width = pct(bar.crossing.boundary - bar.crossing.at);
    el.barFills.append(band);
    // This number is the answer the bar exists to give, so it goes on the
    // bar rather than only in the sentence underneath.
    addChip(band, null, null, [money(bar.crossing.amount), formatPlain(bar.crossing.amount)]);
  }

  for (const tick of bar.ticks) {
    const rule = document.createElement('div');
    rule.className = 'bar-tick' + (tick.isCrossing ? ' is-crossing' : '');
    rule.style.left = pct(tick.at);
    el.barRules.append(rule);
  }

  const flagAt = bar.crossing ? bar.crossing.at : bar.ticks[0] ? bar.ticks[0].at : 0.5;
  const flag = document.createElement('span');
  flag.className = 'bar-flag';
  flag.textContent = 'fair share';
  if (flagAt <= FLAG_EDGE) {
    flag.style.left = '0';
  } else if (flagAt >= 1 - FLAG_EDGE) {
    flag.style.right = '0';
  } else {
    flag.style.left = pct(flagAt);
    flag.style.transform = 'translateX(-50%)';
  }
  el.barFlags.append(flag);

  el.barCaption.replaceChildren();
  if (bar.crossing) {
    const amount = document.createElement('strong');
    amount.textContent = money(bar.crossing.amount);
    el.barCaption.append(
      'The faded stretch is ',
      amount,
      ' paid past the fair-share line. That is what changes hands.'
    );
  } else {
    el.barCaption.textContent = 'Everyone landed on the fair-share line.';
  }

  el.barFills.setAttribute('aria-label', barDescription(bar, money));
}

/**
 * Put the first of `options` that actually fits inside `host`, or nothing.
 *
 * Measuring beats guessing from the slice width: a one-letter name fits in
 * a sliver that a fraction-of-the-bar rule would have written off, and
 * "Alexandra 1.234,00 RON" does not fit in a slice that rule would have
 * allowed. `slot` narrows the chip to part of the host; pass null to use
 * all of it.
 */
function addChip(host, slot, seg, options) {
  const label = document.createElement('span');
  label.className = 'bar-seg-label';
  if (slot && seg) {
    label.style.left = pct((slot.start - seg.start) / seg.width);
    label.style.width = pct(slot.width / seg.width);
  }
  const text = document.createElement('span');
  label.append(text);
  host.append(label);

  // Folded away, everything measures zero. Keep the longest option and let
  // opening the panel re-render and measure for real.
  if (el.barFills.clientWidth === 0) {
    text.textContent = options[0];
    return;
  }

  for (const option of options) {
    text.textContent = option;
    if (text.scrollWidth <= text.clientWidth) return;
  }
  label.remove();
}

/** The part of a slice lying past the fair-share line, or null if none. */
function excessPart(seg, crossing) {
  if (!crossing) return null;
  const start = Math.max(seg.start, crossing.at);
  const end = Math.min(seg.start + seg.width, crossing.boundary);
  return end > start ? { start, width: end - start } : null;
}

/**
 * The wider part of a slice that the faded stretch does not cover, or null
 * when the stretch covers the whole slice.
 */
function clearSlot(seg, crossing) {
  const end = seg.start + seg.width;
  if (!crossing) return { start: seg.start, width: seg.width };

  const left = Math.min(end, crossing.at) - seg.start;
  const right = end - Math.max(seg.start, crossing.boundary);
  if (left <= 0 && right <= 0) return null;
  return left >= right
    ? { start: seg.start, width: left }
    : { start: Math.max(seg.start, crossing.boundary), width: right };
}

function barDescription(bar, money) {
  const parts = bar.segments.map((seg) => {
    const gap =
      seg.net === 0
        ? 'exactly their share'
        : money(Math.abs(seg.net)) + (seg.net > 0 ? ' over their share' : ' under their share');
    return seg.name + ' paid ' + money(seg.paid) + ', ' + gap;
  });
  return (
    'Who paid what against the fair share. Total ' +
    money(bar.total) +
    '. ' +
    parts.join('. ') +
    '.' +
    (bar.crossing ? ' ' + money(bar.crossing.amount) + ' has to change hands.' : '')
  );
}

function renderSettlement(month, people, settlement) {
  const hasPeople = people.length > 0;

  el.settlement.open = store.getState().settlementOpen;
  el.totalSpent.textContent = formatMoney(settlement.total);
  el.summaryTotal.textContent = formatMoney(settlement.total);
  el.settlementEmpty.hidden = hasPeople;
  el.balanceTable.hidden = !hasPeople;
  el.transfersHeading.hidden = !hasPeople;
  el.balanceRows.replaceChildren();
  el.transferList.replaceChildren();
  renderBalanceBar(settlement);

  if (!hasPeople) {
    el.fairShareLine.textContent = 'Nobody is sharing costs yet.';
    el.settledNote.hidden = true;
    fitSettlementType();
    return;
  }

  const share = settlement.people[0].share;
  const uneven = settlement.people.some((p) => p.share !== share);
  el.fairShareLine.textContent =
    'Fair share ' +
    formatMoney(share) +
    ' each across ' +
    headcount(people.length) +
    (uneven ? ', rounded to the nearest ' + MINOR_UNIT : '');

  // settlement.people keeps roster order, so the row index is the same
  // index the bar coloured this person with. The table is the legend.
  settlement.people.forEach((person, colorIndex) => {
    const tr = document.createElement('tr');

    const name = document.createElement('td');
    name.className = 'balance-name';
    const swatch = document.createElement('span');
    swatch.className = 'swatch';
    if (colorIndex < SERIES_COUNT) swatch.dataset.series = String(colorIndex);
    name.append(swatch, person.name);

    const paid = document.createElement('td');
    paid.className = 'numeric';
    paid.textContent = formatPlain(person.paid);

    const fair = document.createElement('td');
    fair.className = 'numeric col-fair';
    fair.textContent = formatPlain(person.share);

    const net = document.createElement('td');
    net.className = 'numeric balance-cell';
    if (person.net > 0) net.classList.add('is-positive');
    if (person.net < 0) net.classList.add('is-negative');
    net.textContent = formatSignedPlain(person.net);

    // The sign carries the meaning on its own, but spell it out so the
    // table does not depend on colour.
    const note = document.createElement('span');
    note.className = 'balance-note';
    note.textContent = person.net > 0 ? 'gets back' : person.net < 0 ? 'owes' : 'settled';
    net.append(note);

    tr.append(name, paid, fair, net);
    el.balanceRows.append(tr);
  });

  const nameById = new Map(settlement.people.map((p) => [p.id, p.name]));
  el.settledNote.hidden = settlement.transfers.length > 0;

  for (const transfer of settlement.transfers) {
    const li = document.createElement('li');

    const text = document.createElement('span');
    text.textContent = nameById.get(transfer.fromId) + ' pays ' + nameById.get(transfer.toId);

    const amount = document.createElement('span');
    amount.className = 'transfer-amount';
    amount.textContent = formatMoney(transfer.amount);

    li.append(text, amount);
    el.transferList.append(li);
  }

  fitSettlementType();
}

// Biggest first. Each step is small enough that the drop reads as the panel
// being tight rather than as a different piece of typography.
const TOTAL_SIZES = ['1.7rem', '1.5rem', '1.32rem', '1.16rem', '1rem'];
const TABLE_SIZES = ['1rem', '0.93rem', '0.86rem', '0.79rem', '0.72rem'];

/**
 * Amounts have no upper bound and the bottom line is the narrowest column
 * on the page, so a fixed type scale breaks the moment somebody logs a
 * six-figure rent. Shrink the number until it fits, the same
 * measure-rather-than-guess trick the bar labels use.
 */
function fitSettlementType() {
  fitToWidth(el.totalSpent, el.totalSpent, TOTAL_SIZES);
  fitToWidth(el.balanceTable, el.balanceScroll, TABLE_SIZES);
}

/**
 * Set the first size in `sizes` at which `box` stops overflowing. Both the
 * node and the box are measured with the text held on one line, so
 * scrollWidth means what it says.
 *
 * Folded away, everything measures zero; opening the panel re-renders and
 * measures for real, so bail out rather than lock in the smallest size.
 */
function fitToWidth(node, box, sizes) {
  if (box.clientWidth === 0) return;
  for (const size of sizes) {
    node.style.fontSize = size;
    if (box.scrollWidth <= box.clientWidth) return;
  }
}

// ------------------------------------------------------------------ helpers

let toastTimer = null;

function toast(message) {
  el.toast.textContent = message;
  el.toast.hidden = false;
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => {
    el.toast.hidden = true;
  }, 2600);
}

function showError(node, message) {
  node.textContent = message || '';
}

/** Promise-based replacement for window.confirm, which blocks the page. */
function askConfirm({ title, message, acceptLabel = 'Delete' }) {
  el.confirmTitle.textContent = title;
  el.confirmMessage.textContent = message;
  el.confirmAccept.textContent = acceptLabel;
  el.confirmDialog.returnValue = '';
  el.confirmDialog.showModal();
  return new Promise((resolve) => {
    el.confirmDialog.addEventListener(
      'close',
      () => resolve(el.confirmDialog.returnValue === 'confirm'),
      { once: true }
    );
  });
}

// ------------------------------------------------------------------- events

el.prevMonth.addEventListener('click', () => {
  store.goToMonth(shiftMonth(store.getState().currentMonthId, -1));
  resetTransientInputs();
});

el.nextMonth.addEventListener('click', () => {
  store.goToMonth(shiftMonth(store.getState().currentMonthId, 1));
  resetTransientInputs();
});

el.thisMonth.addEventListener('click', () => {
  store.goToMonth(currentMonthId());
  resetTransientInputs();
});

el.monthPicker.addEventListener('change', () => {
  const wanted = el.monthPicker.value;
  if (!parseMonthId(wanted)) {
    el.monthPicker.value = store.getState().currentMonthId;
    return;
  }
  store.goToMonth(wanted);
  resetTransientInputs();
});

/** Month-specific form leftovers should not follow the user around. */
function resetTransientInputs() {
  el.addExpenseForm.reset();
  el.expenseDate.value = defaultDateFor(store.getState().currentMonthId);
  showError(el.expenseError, '');
}

// The fit is measured in pixels, so it has to be redone when the panel
// changes width. Debounced: resize fires on every frame of a drag.
let refitTimer = null;
window.addEventListener('resize', () => {
  window.clearTimeout(refitTimer);
  refitTimer = window.setTimeout(fitSettlementType, 120);
});

el.themeToggle.addEventListener('click', () => {
  store.setTheme(otherTheme(store.getState().theme));
});

// The details element owns the open state; the store just remembers it.
el.settlement.addEventListener('toggle', () => {
  if (el.settlement.open !== store.getState().settlementOpen) {
    store.setSettlementOpen(el.settlement.open);
  }
});

function openPeopleDialog() {
  showError(el.personError, '');
  el.personName.value = '';
  el.peopleDialog.showModal();
  el.personName.focus();
}

el.openPeople.addEventListener('click', openPeopleDialog);
el.blockedAddPeople.addEventListener('click', openPeopleDialog);

el.addPersonForm.addEventListener('submit', (event) => {
  event.preventDefault();
  const result = store.addPerson(el.personName.value);
  if (!result.ok) {
    showError(el.personError, result.error);
    return;
  }
  showError(el.personError, '');
  el.personName.value = '';
  el.personName.focus();
});

el.peopleList.addEventListener('change', (event) => {
  const input = event.target.closest('.person-name');
  if (input) commitRename(input);
});

el.peopleList.addEventListener('keydown', (event) => {
  const input = event.target.closest('.person-name');
  if (!input) return;
  if (event.key === 'Enter') {
    event.preventDefault();
    commitRename(input);
  }
  if (event.key === 'Escape') {
    // Undo the edit without letting Escape close the dialog too.
    event.stopPropagation();
    render();
  }
});

function commitRename(input) {
  const result = store.renamePerson(input.dataset.personId, input.value);
  if (!result.ok) {
    showError(el.personError, result.error);
    render();
    return;
  }
  showError(el.personError, '');
}

function startRemovePerson(personId) {
  const attempt = store.removePerson(personId);
  if (attempt.ok) return;

  if (!attempt.needsDecision) {
    toast(attempt.error);
    return;
  }

  const people = store.getPeople();
  const person = people.find((p) => p.id === personId);
  const others = people.filter((p) => p.id !== personId);

  removingPersonId = personId;
  el.removeName.textContent = person.name;
  el.removeMessage.textContent =
    person.name +
    ' paid for ' +
    attempt.expenseCount +
    (attempt.expenseCount === 1 ? ' expense' : ' expenses') +
    ' across ' +
    (attempt.monthCount === 1 ? '1 month' : attempt.monthCount + ' months') +
    '.';
  showError(el.removeError, '');

  fillPersonSelect(el.reassignTarget, others, others.length ? others[0].id : '');
  const reassignRadio = el.removeForm.querySelector('input[value="reassign"]');
  reassignRadio.disabled = others.length === 0;
  el.reassignTarget.disabled = others.length === 0;
  el.removeForm.querySelector('input[value="delete"]').checked = others.length === 0;
  reassignRadio.checked = others.length > 0;

  el.removeDialog.showModal();
}

el.removeForm.addEventListener('submit', (event) => {
  const mode = el.removeForm.querySelector('input[name="remove-mode"]:checked');
  const result = store.removePerson(removingPersonId, {
    mode: mode ? mode.value : undefined,
    targetId: el.reassignTarget.value,
  });
  if (!result.ok) {
    event.preventDefault();
    showError(el.removeError, result.error);
    return;
  }
  removingPersonId = null;
});

el.addExpenseForm.addEventListener('submit', (event) => {
  event.preventDefault();
  const amount = parseAmount(el.expenseAmount.value);
  if (amount === null || amount <= 0) {
    showError(el.expenseError, 'Enter an amount greater than zero, for example 42,50.');
    el.expenseAmount.focus();
    return;
  }

  const result = store.addExpense({
    amount,
    payerId: el.expensePayer.value,
    description: el.expenseDescription.value,
    date: el.expenseDate.value,
  });

  if (!result.ok) {
    showError(el.expenseError, result.error);
    return;
  }

  showError(el.expenseError, '');
  const keptDate = el.expenseDate.value;
  const keptPayer = el.expensePayer.value;
  el.expenseAmount.value = '';
  el.expenseDescription.value = '';
  el.expenseDate.value = keptDate;
  el.expensePayer.value = keptPayer;
  el.expenseAmount.focus();
});

el.expenseAmount.addEventListener('blur', () => {
  const amount = parseAmount(el.expenseAmount.value);
  if (amount !== null) el.expenseAmount.value = formatPlain(amount);
});

/**
 * Drops anything that is not a digit or a separator, whether it was
 * typed, pasted, dictated, or dropped in, and puts the caret back where
 * the user left it.
 */
function acceptOnlyAmounts(input) {
  input.addEventListener('input', () => {
    const typed = input.value;
    const kept = sanitizeAmountInput(typed);
    if (kept === typed) return;

    const caret = input.selectionStart;
    const removedBeforeCaret =
      caret === null ? 0 : caret - sanitizeAmountInput(typed.slice(0, caret)).length;
    input.value = kept;
    if (caret !== null) {
      const at = Math.max(0, caret - removedBeforeCaret);
      input.setSelectionRange(at, at);
    }
  });
}

acceptOnlyAmounts(el.expenseAmount);
acceptOnlyAmounts(el.editAmount);

function openEditDialog(expenseId) {
  const month = store.getCurrentMonth();
  const expense = month.expenses.find((e) => e.id === expenseId);
  if (!expense) return;

  editingExpenseId = expenseId;
  el.editAmount.value = formatPlain(expense.amount);
  fillPersonSelect(el.editPayer, store.getPeople(), expense.payerId);
  el.editDate.value = expense.date || '';
  el.editDescription.value = expense.description || '';
  showError(el.editError, '');
  el.expenseDialog.showModal();
  el.editAmount.focus();
  el.editAmount.select();
}

el.editForm.addEventListener('submit', (event) => {
  const amount = parseAmount(el.editAmount.value);
  if (amount === null || amount <= 0) {
    event.preventDefault();
    showError(el.editError, 'Enter an amount greater than zero, for example 42,50.');
    return;
  }
  const result = store.updateExpense(editingExpenseId, {
    amount,
    payerId: el.editPayer.value,
    description: el.editDescription.value,
    date: el.editDate.value,
  });
  if (!result.ok) {
    event.preventDefault();
    showError(el.editError, result.error);
    return;
  }
  editingExpenseId = null;
  toast('Expense updated.');
});

async function confirmDeleteExpense(expense) {
  const month = store.getCurrentMonth();
  const label = expense.description
    ? '"' + expense.description + '"'
    : 'the ' + formatMoney(expense.amount) + ' expense';
  const yes = await askConfirm({
    title: 'Delete this expense?',
    message: 'This removes ' + label + ' from ' + monthLabel(month.id) + '.',
  });
  if (!yes) return;
  store.deleteExpense(expense.id);
  toast('Expense deleted.');
}

// ------------------------------------------------------- export and import

function expenseCount(n) {
  return n === 1 ? '1 expense' : n + ' expenses';
}

function renderExportMonths() {
  const state = store.getState();
  const ids = exportableMonths(state).reverse(); // newest first, like the table

  for (const id of [...exportSelection]) {
    if (!ids.includes(id)) exportSelection.delete(id);
  }

  el.exportEmpty.hidden = ids.length > 0;
  el.exportMonths.hidden = ids.length === 0;
  el.exportMonths.replaceChildren();

  for (const id of ids) {
    const expenses = state.months[id].expenses;
    const total = expenses.reduce((sum, e) => sum + e.amount, 0);

    const li = document.createElement('li');
    const label = document.createElement('label');
    label.className = 'month-option';

    const box = document.createElement('input');
    box.type = 'checkbox';
    box.value = id;
    box.checked = exportSelection.has(id);
    box.addEventListener('change', () => {
      if (box.checked) exportSelection.add(id);
      else exportSelection.delete(id);
      renderExportButton();
    });

    const name = document.createElement('span');
    name.className = 'month-option-name';
    name.textContent = monthLabel(id);

    const meta = document.createElement('span');
    meta.className = 'month-option-meta';
    meta.textContent = expenseCount(expenses.length) + ' · ' + formatMoney(total);

    label.append(box, name, meta);
    li.append(label);
    el.exportMonths.append(li);
  }

  renderExportButton();
}

function renderExportButton() {
  const picked = exportSelection.size;
  el.exportBtn.disabled = picked === 0;
  el.exportBtn.textContent =
    picked === 0
      ? 'Export'
      : picked === 1
        ? 'Export 1 month'
        : 'Export ' + picked + ' months';
}

function chosenFormat() {
  const picked = el.dataDialog.querySelector('input[name="export-format"]:checked');
  return picked ? picked.value : 'json';
}

function openDataDialog() {
  const ids = exportableMonths(store.getState());
  // Everything is ticked to start with: the common case is "give me the
  // lot", and unticking three boxes is easier than ticking twelve.
  exportSelection.clear();
  for (const id of ids) exportSelection.add(id);

  showError(el.exportError, '');
  showError(el.importError, '');
  el.importFileLabel.textContent = 'Choose a JSON or CSV file';
  el.importFile.value = '';
  renderExportMonths();
  el.dataDialog.showModal();
}

el.openData.addEventListener('click', openDataDialog);
el.footerData.addEventListener('click', openDataDialog);

el.exportAll.addEventListener('click', () => {
  for (const id of exportableMonths(store.getState())) exportSelection.add(id);
  renderExportMonths();
});

el.exportNone.addEventListener('click', () => {
  exportSelection.clear();
  renderExportMonths();
});

el.exportBtn.addEventListener('click', () => {
  const file = buildExport(store.getState(), [...exportSelection], chosenFormat());
  if (!file.ok) {
    showError(el.exportError, file.error);
    return;
  }
  showError(el.exportError, '');
  downloadFile(file);
  toast('Saved ' + file.filename);
});

/**
 * Hand the file to the browser's own download machinery. Works from a
 * file:// page, which is the whole point of shipping one HTML file.
 */
function downloadFile({ filename, mime, text }) {
  const url = URL.createObjectURL(new Blob([text], { type: mime }));
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  // Freed on the next turn of the loop: revoking straight away cancels
  // the download in Safari.
  window.setTimeout(() => URL.revokeObjectURL(url), 2000);
}

el.importFile.addEventListener('change', async () => {
  const file = el.importFile.files && el.importFile.files[0];
  if (!file) return;

  showError(el.importError, '');
  el.importFileLabel.textContent = file.name;

  let text;
  try {
    text = await file.text();
  } catch {
    showError(el.importError, 'That file could not be read.');
    el.importFile.value = '';
    return;
  }
  // Let the same file be picked again after a cancel.
  el.importFile.value = '';

  const parsed = parseImportFile(text);
  if (!parsed.ok) {
    showError(el.importError, parsed.error);
    return;
  }

  pendingImport = parsed;
  showImportPreview(parsed, file.name);
});

function showImportPreview(payload, filename) {
  const preview = previewImport(store.getState(), payload);

  el.importSummary.textContent =
    filename +
    ' holds ' +
    expenseCount(preview.totalExpenses) +
    ' across ' +
    (preview.months.length === 1 ? '1 month' : preview.months.length + ' months') +
    '.';

  el.importPreview.replaceChildren();
  for (const month of preview.months) {
    const li = document.createElement('li');
    li.className = 'import-row' + (month.existing > 0 ? ' is-replacing' : '');

    const name = document.createElement('span');
    name.className = 'import-row-name';
    name.textContent = month.label;

    const what = document.createElement('span');
    what.className = 'import-row-what';

    const incoming = document.createElement('span');
    incoming.textContent = expenseCount(month.incoming) + ' · ' + formatMoney(month.total);

    const fate = document.createElement('span');
    fate.textContent =
      month.existing > 0 ? 'replaces ' + expenseCount(month.existing) + ' here' : 'new month';

    what.append(incoming, fate);
    li.append(name, what);
    el.importPreview.append(li);
  }

  el.importPeople.hidden = preview.newPeople.length === 0;
  if (preview.newPeople.length > 0) {
    el.importPeople.textContent =
      'Adds to the people list: ' + preview.newPeople.join(', ') + '.';
  }

  el.importUntouched.hidden = preview.untouched.length === 0;
  if (preview.untouched.length > 0) {
    el.importUntouched.textContent =
      'Left alone: ' + preview.untouched.map(monthLabel).join(', ') + '.';
  }

  // Adding months is routine; replacing months you already filled in is
  // not, so the button changes colour to match what it is about to do.
  const overwrites = preview.replacing > 0;
  el.importAccept.className = overwrites ? 'danger-btn' : 'primary-btn';
  el.importAccept.textContent = overwrites ? 'Replace and import' : 'Import';

  const skipped = payload.skipped ? payload.skipped.length : 0;
  showError(
    el.importWarning,
    [
      preview.replacing > 0
        ? 'This overwrites ' +
          (preview.replacing === 1 ? '1 month' : preview.replacing + ' months') +
          ' you already have. There is no undo.'
        : '',
      skipped > 0
        ? skipped + (skipped === 1 ? ' row' : ' rows') + ' in the file could not be read.'
        : '',
    ]
      .filter(Boolean)
      .join(' ')
  );

  el.importDialog.returnValue = '';
  el.importDialog.showModal();
}

el.importDialog.addEventListener('close', () => {
  const accepted = el.importDialog.returnValue === 'import';
  const payload = pendingImport;
  pendingImport = null;
  if (!accepted || !payload) return;

  const result = store.importMonths(payload);
  if (!result.ok) {
    showError(el.importError, result.error);
    return;
  }
  el.dataDialog.close('cancel');
  resetTransientInputs();
  toast(
    'Imported ' +
      expenseCount(result.expenses) +
      ' into ' +
      (result.months === 1 ? '1 month' : result.months + ' months') +
      '.'
  );
});

for (const button of document.querySelectorAll('[data-close-dialog]')) {
  button.addEventListener('click', () => {
    const dialog = button.closest('dialog');
    if (dialog) dialog.close('cancel');
  });
}

// Clicking the backdrop closes the dialog, matching what people expect.
// The press has to start on the backdrop too, otherwise the click that
// opened the dialog closes it again, and selecting text inside then
// releasing outside would throw away what you were editing.
for (const dialog of document.querySelectorAll('dialog')) {
  let pressedBackdrop = false;
  dialog.addEventListener('mousedown', (event) => {
    pressedBackdrop = event.target === dialog;
  });
  dialog.addEventListener('click', (event) => {
    if (pressedBackdrop && event.target === dialog) dialog.close('cancel');
    pressedBackdrop = false;
  });
}

// ----------------------------------------------------------------- sharing

const memory = createDeviceMemory();

/** The last thing the sharing layer told us about itself. */
let shareState = {
  mode: MODE.local,
  status: STATUS.offline,
  usage: null,
  available: false,
  pending: 0,
  roomId: null,
};

/** Counted when the dialog opens, so rendering it stays cheap. */
let localOpCount = 0;

sharing = createSharing({
  store,
  endpoint: syncEndpoint(document, window.location),
  memory,
  onStatus: (next) => {
    shareState = next;
    renderSharing();
  },
  onNotice: (notice) => {
    if (notice.message) toast(notice.message);
  },
});

const STATUS_WORD = {
  [STATUS.online]: 'Live',
  [STATUS.connecting]: 'Connecting',
  [STATUS.offline]: 'Offline',
  [STATUS.blocked]: 'Unavailable',
};

function renderSharing() {
  const inRoom = shareState.mode === MODE.room;

  el.syncDot.hidden = !inRoom;
  el.syncDot.dataset.status = shareState.status;
  el.syncDot.title = inRoom ? STATUS_WORD[shareState.status] : '';
  el.openShare.classList.toggle('is-shared', inRoom);

  el.footerLocal.hidden = inRoom;
  el.footerShared.hidden = !inRoom;

  if (el.shareDialog.open) renderShareDialog();
}

function renderShareDialog() {
  const inRoom = shareState.mode === MODE.room;

  el.shareUnavailable.hidden = shareState.available;
  el.shareCreate.hidden = inRoom || !shareState.available;
  el.shareJoin.hidden = inRoom || !shareState.available;
  el.shareActive.hidden = !inRoom;

  if (!shareState.available) {
    el.shareIntro.textContent =
      'Sharing needs the app to be open from its web address over https.';
    el.shareUnavailable.textContent =
      window.location.protocol === 'file:'
        ? 'This copy is running from a file on disk, so it has no server to talk to and no way to encrypt anything. Open the hosted version to share.'
        : 'This page cannot reach the sync server.';
    return;
  }

  if (!inRoom) {
    el.shareIntro.textContent =
      'Right now these months live in this browser and nowhere else. A shared tracker puts them behind one link so two people can add and edit at the same time, on any device.';
    renderKnownRooms();
    return;
  }

  el.shareIntro.textContent =
    'Anyone with the link and the password sees these months and can change them, live.';
  el.shareLink.value = sharing.getLink();
  renderShareStatus();
  renderMoveLocal();
  renderUsage();
}

function renderShareStatus() {
  const pending = shareState.pending;
  el.shareStatus.dataset.status = shareState.status;
  el.shareStatus.textContent =
    shareState.status === STATUS.online
      ? 'Live. Changes show up on the other device straight away.'
      : shareState.status === STATUS.connecting
        ? 'Connecting…'
        : shareState.status === STATUS.blocked
          ? 'This tracker is not available. The link may have been removed.'
          : pending > 0
            ? 'Offline. ' +
              (pending === 1 ? '1 change is' : pending + ' changes are') +
              ' waiting and will go up when the connection is back.'
            : 'Offline. You can keep working; changes go up when the connection is back.';
}

/**
 * Only offered into a room that is still empty. Pushing your months into a
 * room somebody else has already filled is a merge, and a merge is the one
 * thing this design refuses to guess at.
 */
function renderMoveLocal() {
  const state = store.getState();
  const roomEmpty =
    state.people.length === 0 &&
    Object.values(state.months).every((month) => month.expenses.length === 0);
  const offer = roomEmpty && localOpCount > 0 && shareState.status === STATUS.online;

  el.moveLocal.hidden = !offer;
  el.moveLocalNote.hidden = !offer;
  if (offer) {
    el.moveLocalNote.textContent =
      'This tracker is empty and you have months of your own on this device. Move them in and they become the shared ones. Your own copy is left exactly as it is.';
  }
}

function renderUsage() {
  const usage = shareState.usage;
  el.usageBlock.hidden = !usage;
  if (!usage) return;

  const share = Math.min(1, usage.bytes / usage.limitBytes);
  el.usageFill.style.width = (share * 100).toFixed(1) + '%';
  el.usageFill.dataset.level = share > 0.9 ? 'high' : share > 0.7 ? 'warn' : 'ok';
  el.usageLabel.textContent =
    usage.records +
    (usage.records === 1 ? ' entry, ' : ' entries, ') +
    Math.round(share * 100) +
    '% of the space this tracker gets';
}

function renderKnownRooms() {
  const rooms = knownRooms(memory).filter((room) => sharing.knownRoom(room.id));
  el.knownRoomsLabel.hidden = rooms.length === 0;
  el.knownRoomsList.replaceChildren();

  for (const room of rooms) {
    const li = document.createElement('li');
    const open = document.createElement('button');
    open.type = 'button';
    open.className = 'link-btn';
    open.textContent = 'Open ' + room.id.slice(0, 6) + '…';
    open.addEventListener('click', async () => {
      el.shareDialog.close('cancel');
      window.location.hash = 's=' + room.id;
      const opened = await sharing.start();
      if (opened.mode === MODE.locked) openUnlockDialog();
    });

    const when = document.createElement('span');
    when.className = 'hint';
    when.textContent = room.seenAt ? 'last opened ' + shortDay(room.seenAt) : '';

    li.append(open, when);
    el.knownRoomsList.append(li);
  }
}

function shortDay(ms) {
  const days = Math.floor((Date.now() - ms) / 86400000);
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  return days + ' days ago';
}

function openShareDialog() {
  showError(el.createError, '');
  showError(el.joinError, '');
  el.joinLink.value = '';
  localOpCount = sharing.isAvailable() ? sharing.localOps().length : 0;
  renderShareDialog();
  el.shareDialog.showModal();
}

el.openShare.addEventListener('click', openShareDialog);

// ------------------------------------------------------ making a tracker

el.createRoomForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const code = el.inviteCode.value.trim();
  const password = el.newPassword.value;

  if (!code) return showError(el.createError, 'Enter the invite code you were given.');
  if (password.length < 8) {
    return showError(el.createError, 'Use a password of at least 8 characters.');
  }
  if (password !== el.newPasswordAgain.value) {
    return showError(el.createError, 'The two passwords are not the same.');
  }

  showError(el.createError, '');
  // Deriving the key takes about a second on a phone, on purpose.
  const done = busy(el.createRoomBtn, 'Locking it…');
  const result = await sharing.create(code, password);
  done();

  if (!result.ok) return showError(el.createError, result.error);

  el.createRoomForm.reset();
  el.shareDialog.close('cancel');
  showRecoveryKey(result.recoveryKey, {
    title: 'Write this down',
    intro:
      'This is the only way back into this tracker if the password is forgotten. There is no reset, because nobody else holds a copy, including whoever runs this server.',
    warning: 'Keep it somewhere other than this browser.',
  });
});

el.joinRoomForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const typed = el.joinLink.value.trim();
  const id = readRoomId(typed.includes('#') ? typed.slice(typed.indexOf('#')) : '#s=' + typed);

  if (!isRoomId(id)) {
    return showError(el.joinError, 'That does not look like a tracker link.');
  }
  showError(el.joinError, '');
  el.shareDialog.close('cancel');
  window.location.hash = 's=' + id;
  const opened = await sharing.start();
  if (opened.mode === MODE.locked) openUnlockDialog();
});

// ------------------------------------------------------------- unlocking

function openUnlockDialog() {
  showError(el.unlockError, '');
  el.unlockPassword.value = '';
  el.unlockRecovery.value = '';
  el.recoveryField.hidden = true;
  el.passwordField.hidden = false;
  el.useRecovery.hidden = false;
  el.unlockDialog.showModal();
  el.unlockPassword.focus();
}

el.useRecovery.addEventListener('click', () => {
  el.passwordField.hidden = true;
  el.recoveryField.hidden = false;
  el.useRecovery.hidden = true;
  el.unlockIntro.textContent =
    'The long string that was shown when this tracker was made. Spacing and capitals do not matter.';
  el.unlockRecovery.focus();
});

el.unlockForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const done = busy(el.unlockBtn, 'Unlocking…');
  const result = el.recoveryField.hidden
    ? await sharing.unlock(el.unlockPassword.value)
    : await sharing.unlockWithRecoveryKey(el.unlockRecovery.value);
  done();

  if (!result.ok) return showError(el.unlockError, result.error);
  el.unlockDialog.close('cancel');
  toast('Unlocked on this device.');
});

// A link opened and then dismissed leaves the app on its own months, so
// the fragment has to go with it or a reload asks again out of nowhere.
el.unlockDialog.addEventListener('close', () => {
  if (shareState.mode === MODE.locked) sharing.leave();
});

// --------------------------------------------------- being in a tracker

el.copyLink.addEventListener('click', async () => {
  const copied = await copyText(el.shareLink, sharing.getLink());
  toast(copied ? 'Link copied. Send the password separately.' : 'Select the link and copy it.');
});

el.moveLocal.addEventListener('click', async () => {
  const yes = await askConfirm({
    title: 'Move your months in?',
    message:
      'Everything on this device is copied into the shared tracker, where the other person will see it. Your own copy stays where it is.',
    acceptLabel: 'Move them in',
  });
  if (!yes) return;

  const result = sharing.moveLocalDataIn();
  if (!result.ok) return toast(result.error);
  localOpCount = 0;
  renderShareDialog();
  toast('Moved in. It is syncing now.');
});

el.showRecovery.addEventListener('click', async () => {
  showRecoveryKey(await sharing.getRecoveryKey(), {
    title: 'Recovery key',
    intro:
      'The way back in if the password is forgotten. Anyone holding this string can read the tracker without knowing the password, so treat it like the password itself.',
    warning: '',
  });
});

function showRecoveryKey(key, { title, intro, warning }) {
  el.recoveryTitle.textContent = title;
  el.recoveryIntro.textContent = intro;
  el.recoveryKey.textContent = key || '';
  showError(el.recoveryWarning, warning);
  el.recoveryDialog.showModal();
}

el.copyRecovery.addEventListener('click', async () => {
  const copied = await copyText(null, el.recoveryKey.textContent);
  toast(copied ? 'Recovery key copied.' : 'Select it and copy it.');
});

el.changePassword.addEventListener('click', () => {
  showError(el.changeError, '');
  el.passwordForm.reset();
  el.passwordDialog.showModal();
  el.changeNew.focus();
});

el.passwordForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const next = el.changeNew.value;
  if (next.length < 8) {
    return showError(el.changeError, 'Use a password of at least 8 characters.');
  }
  if (next !== el.changeAgain.value) {
    return showError(el.changeError, 'The two passwords are not the same.');
  }

  const done = busy(event.submitter || el.passwordForm.querySelector('.primary-btn'), 'Saving…');
  const result = await sharing.changePassword(next);
  done();

  if (!result.ok) return showError(el.changeError, result.error);
  el.passwordDialog.close('cancel');
  toast('Password changed. Devices already unlocked keep working.');
});

el.leaveRoom.addEventListener('click', async () => {
  const pending = shareState.pending;
  const yes = await askConfirm({
    title: 'Leave on this device?',
    message:
      'The tracker itself is untouched and the link still works. This browser forgets the password and goes back to your own months.' +
      (pending > 0
        ? ' ' +
          (pending === 1 ? '1 change has' : pending + ' changes have') +
          ' not reached the server yet and will be lost.'
        : ''),
    acceptLabel: 'Leave it',
  });
  if (!yes) return;

  sharing.leave({ forget: true });
  el.shareDialog.close('cancel');
  resetTransientInputs();
  toast('Back to your own months.');
});

// ------------------------------------------------------------- plumbing

/** Disable a button and say what it is doing. Returns the undo. */
function busy(button, label) {
  const wasLabel = button.textContent;
  button.disabled = true;
  button.textContent = label;
  return () => {
    button.disabled = false;
    button.textContent = wasLabel;
  };
}

async function copyText(input, text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Denied, or an older browser. Select it so the keyboard still works.
    if (input) {
      input.focus();
      input.select();
    }
    return false;
  }
}

// A laptop coming out of sleep has a socket that looks open and delivers
// nothing, so nudge it the moment the tab is looked at again.
window.addEventListener('online', () => sharing.reconnect());
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && shareState.mode === MODE.room) sharing.resync();
});

// Someone pasting a different link into the address bar of an open tab.
window.addEventListener('hashchange', async () => {
  const id = readRoomId(window.location.hash);
  if (id && id !== shareState.roomId) {
    const opened = await sharing.start();
    if (opened.mode === MODE.locked) openUnlockDialog();
  }
});

store.subscribe(render);
render();

sharing.start().then((opened) => {
  if (opened.mode === MODE.locked) openUnlockDialog();
});

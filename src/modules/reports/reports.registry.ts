/**
 * Every report the API can run, in one list.
 *
 * A registry rather than an endpoint per report, and never a generic query
 * endpoint: a caller-supplied query would be an RLS-bypass surface and would
 * make the plan gate structurally unenforceable. Adding a report is adding an
 * entry here; the envelope, the outlet boundary, the tier gate and the CSV
 * export come with it.
 */
import { customerOutstanding, khataStatement } from './queries/customers.js';
import { currentStock, lowStock, stockMovement } from './queries/inventory.js';
import { dailyProfitAndLoss, expenseSummary } from './queries/money.js';
import {
  billRegister,
  categoryWiseSales,
  dayBook,
  itemWiseSales,
  paymentModeSplit,
  salesSummary,
} from './queries/sales.js';
import type { ReportColumn, ReportDefinition } from './reports.types.js';

const money = (key: string, label: string, total = true): ReportColumn => ({
  key,
  label,
  kind: 'money',
  total,
});
const qty = (key: string, label: string, total = true): ReportColumn => ({
  key,
  label,
  kind: 'quantity',
  total,
});
const count = (key: string, label: string): ReportColumn => ({
  key,
  label,
  kind: 'number',
  total: true,
});
const text = (key: string, label: string, secondary = false): ReportColumn => ({
  key,
  label,
  kind: 'text',
  secondary,
});
const date = (key: string, label: string): ReportColumn => ({ key, label, kind: 'date' });
const datetime = (key: string, label: string): ReportColumn => ({
  key,
  label,
  kind: 'datetime',
});

export const REPORTS: readonly ReportDefinition[] = [
  {
    id: 'day-book',
    title: 'Day book',
    description: 'Every sale, return, collection and expense, in the order it happened.',
    group: 'sales',
    filters: ['outletId', 'from', 'to', 'limit'],
    columns: [
      datetime('at', 'Time'),
      text('type', 'Type'),
      text('reference', 'Reference'),
      text('party', 'Party'),
      money('amount', 'In'),
      money('outflow', 'Out'),
    ],
    run: dayBook,
  },
  {
    id: 'sales-summary',
    title: 'Sales summary',
    description: 'Turnover, tax, discount and returns for each day.',
    group: 'sales',
    filters: ['outletId', 'from', 'to'],
    columns: [
      date('date', 'Date'),
      count('billCount', 'Bills'),
      money('taxableAmount', 'Taxable'),
      money('taxAmount', 'Tax'),
      money('discount', 'Discount'),
      money('grandTotal', 'Sales'),
      money('returnTotal', 'Returns'),
      money('netSales', 'Net'),
    ],
    run: salesSummary,
  },
  {
    id: 'item-wise-sales',
    title: 'Item-wise sales',
    description: 'What sold, and what it earned. Best sellers first.',
    group: 'sales',
    filters: ['outletId', 'from', 'to', 'categoryId', 'itemId', 'limit'],
    columns: [
      text('itemName', 'Item'),
      text('category', 'Category', true),
      qty('quantity', 'Qty'),
      money('discount', 'Discount'),
      money('taxableAmount', 'Taxable'),
      money('taxAmount', 'Tax'),
      money('lineTotal', 'Total'),
    ],
    run: itemWiseSales,
  },
  {
    id: 'category-wise-sales',
    title: 'Category-wise sales',
    description: 'Which parts of the shop earn their shelf space.',
    group: 'sales',
    filters: ['outletId', 'from', 'to'],
    columns: [
      text('category', 'Category'),
      count('billCount', 'Bills'),
      qty('quantity', 'Qty'),
      money('taxableAmount', 'Taxable'),
      money('lineTotal', 'Total'),
    ],
    run: categoryWiseSales,
  },
  {
    id: 'payment-mode-split',
    title: 'Payment mode split',
    description: 'Cash, card, UPI and the rest, net of refunds.',
    group: 'money',
    filters: ['outletId', 'from', 'to'],
    columns: [
      text('mode', 'Mode'),
      count('txnCount', 'Count'),
      money('atBilling', 'At billing'),
      money('collections', 'Collections'),
      money('refunds', 'Refunds'),
      money('net', 'Net'),
    ],
    run: paymentModeSplit,
  },
  {
    id: 'bill-register',
    title: 'Bill register',
    description: 'Every invoice issued, including voided ones, for reconciliation.',
    group: 'sales',
    filters: ['outletId', 'from', 'to', 'customerId', 'limit'],
    columns: [
      date('date', 'Date'),
      text('documentNumber', 'Invoice no.'),
      text('customer', 'Customer'),
      text('customerGstin', 'GSTIN', true),
      money('taxableAmount', 'Taxable'),
      money('taxAmount', 'Tax'),
      money('grandTotal', 'Total'),
      text('status', 'Status'),
    ],
    run: billRegister,
  },
  {
    id: 'current-stock',
    title: 'Current stock',
    description: 'What is on the shelf, and what it is worth at cost.',
    group: 'inventory',
    filters: ['outletId', 'categoryId', 'limit'],
    columns: [
      text('itemName', 'Item'),
      text('category', 'Category', true),
      text('unit', 'Unit', true),
      qty('quantity', 'On hand'),
      money('unitCost', 'Cost', false),
      money('salePrice', 'Price', false),
      money('stockValue', 'Value'),
    ],
    run: currentStock,
  },
  {
    id: 'low-stock',
    title: 'Low stock',
    description: 'Items at or below their reorder level. The buying list.',
    group: 'inventory',
    filters: ['outletId', 'limit'],
    columns: [
      text('itemName', 'Item'),
      text('category', 'Category', true),
      qty('quantity', 'On hand'),
      qty('reorderLevel', 'Reorder at', false),
      qty('shortfall', 'Short by'),
      money('unitCost', 'Cost', false),
    ],
    run: lowStock,
  },
  {
    id: 'stock-movement',
    title: 'Fast and dead stock',
    description:
      'Units sold against units still on the shelf. Stock with no sales is money standing still.',
    group: 'inventory',
    filters: ['outletId', 'from', 'to', 'limit'],
    columns: [
      text('itemName', 'Item'),
      text('category', 'Category', true),
      qty('quantitySold', 'Sold'),
      money('salesValue', 'Sales'),
      qty('onHand', 'On hand'),
      date('lastSoldOn', 'Last sold'),
    ],
    run: stockMovement,
  },
  {
    id: 'customer-outstanding',
    title: 'Customer outstanding',
    description: 'Who owes money, with a 30/60/90 day ageing split.',
    group: 'customers',
    filters: ['customerId', 'limit'],
    columns: [
      text('customer', 'Customer'),
      text('phone', 'Phone'),
      money('days0to30', '0-30 days'),
      money('days31to60', '31-60 days'),
      money('days61to90', '61-90 days'),
      money('days90plus', '90+ days'),
      money('balance', 'Balance'),
      date('oldestUnpaid', 'Oldest bill'),
    ],
    run: customerOutstanding,
  },
  {
    id: 'khata-statement',
    title: 'Khata statement',
    description: 'One customer’s account, as it would be handed over.',
    group: 'customers',
    filters: ['customerId', 'from', 'to', 'limit'],
    columns: [
      datetime('at', 'Date'),
      text('particulars', 'Particulars'),
      text('reference', 'Reference', true),
      money('debit', 'Debit'),
      money('credit', 'Credit'),
      money('balance', 'Balance', false),
    ],
    run: khataStatement,
  },
  {
    id: 'expense-summary',
    title: 'Expense summary',
    description: 'Where the money went, by category.',
    group: 'money',
    filters: ['outletId', 'from', 'to', 'categoryId'],
    columns: [
      text('category', 'Category'),
      count('entryCount', 'Entries'),
      money('paidInCash', 'In cash'),
      money('amount', 'Total'),
    ],
    run: expenseSummary,
  },
  {
    id: 'daily-pnl',
    title: 'Daily profit and loss',
    description:
      'Sales less estimated cost and expenses, per day. Cost uses each item’s current purchase price until purchase bills record what a unit actually cost.',
    group: 'money',
    // A cashier may run the day book; they may not see the shop's margin.
    permission: 'reports:financial',
    filters: ['outletId', 'from', 'to'],
    columns: [
      date('date', 'Date'),
      money('netSales', 'Net sales'),
      money('estimatedCost', 'Est. cost'),
      money('grossMargin', 'Gross margin'),
      money('directExpenses', 'Direct exp.'),
      money('indirectExpenses', 'Other exp.'),
      money('netProfit', 'Net'),
    ],
    run: dailyProfitAndLoss,
  },
];

const BY_ID = new Map<string, ReportDefinition>(REPORTS.map((r) => [r.id, r]));

export function findReport(id: string): ReportDefinition | undefined {
  return BY_ID.get(id);
}
